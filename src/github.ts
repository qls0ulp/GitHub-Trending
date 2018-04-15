import cheerio from 'cheerio';
import _ from 'lodash';
import request from 'request-promise';
import util from 'util';
import winston from 'winston';

import { IShowcase } from './interfaces';

export default class GitHubClient {
  constructor(readonly token: string) {
    if (!token) {
      throw new Error('Invalid GitHub token!');
    }
  }

  public getRepository(user: string, name: string) {
    return request({
      auth: {
        pass: this.token,
        sendImmediately: true,
        user: 'token'
      },
      headers: { 'User-Agent': 'CodeHub-Trending' },
      method: 'GET',
      resolveWithFullResponse: true,
      url: `https://api.github.com/repos/${user}/${name}`
    }).then((response: request.RequestPromise) => {
      const rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining'], 10);
      const resetSeconds = parseInt(response.headers['x-ratelimit-reset'], 10);
      const nowSeconds = Math.round(new Date().getTime() / 1000);
      const duration = resetSeconds - nowSeconds + 60;

      // We need to drop the permission object from every repository
      // because that state belongs to the user that is authenticated
      // at the curren time; which is misrepresentitive of the client
      // attempting to query this information.
      const repoBody = _.omit(JSON.parse(response.body.toString()), 'permissions');

      // Make sure we don't drain the rate limit
      if (rateLimitRemaining < 400) {
        winston.warn('Pausing for %s to allow rateLimit to reset', duration);
        return new Promise(res => setTimeout(res, duration * 1000)).then(() => repoBody);
      }

      return repoBody;
    });
  }

  public async getTrendingRepositories(time: string, language?: string | null) {
    const queryString: { [id: string]: string } = { since: time };
    if (language) {
      queryString.l = language;
    }

    const result = await request({
      headers: { 'X-PJAX': 'true' },
      method: 'GET',
      qs: queryString,
      url: 'https://github.com/trending'
    });

    const $ = cheerio.load(result);
    const owners: Array<{ owner: string; name: string }> = [];

    $('div.explore-content > ol > li').each((idx, el) => {
      const owner = $('h3 > a', el)
        .attr('href')
        .split('/');

      owners.push({ owner: owner[1], name: owner[2] });
    });

    const repos = [];

    for (const r of owners) {
      const { owner, name } = r;
      repos.push(await this.getRepository(owner, name));
    }

    return repos;
  }

  public async getLanguages() {
    const result = await request({
      headers: { 'X-PJAX': 'true' },
      method: 'GET',
      url: 'https://github.com/trending'
    });

    const $ = cheerio.load(result);
    const languages: Array<{ name: string; slug: string }> = [];

    $('.col-md-3 .select-menu .select-menu-list a.select-menu-item').each((idx, el) => {
      const href = $(el).attr('href');
      const slug = decodeURIComponent(href.substring(href.lastIndexOf('/') + 1));
      const name = $(el)
        .text()
        .trim();

      languages.push({ name, slug });
    });

    return languages;
  }

  public async getShowcases() {
    const showcases: IShowcase[] = [];

    const addShowcases = (data: any) => {
      const $ = cheerio.load(data);

      $('article').each((idx, el) => {
        const anchor = $('a', el);
        const href = anchor.attr('href');
        const name = anchor.text();
        const slug = href.split('/').slice(-1)[0];
        const image = $('img', el).attr('src');
        const description = $('div.col-10.col-md-11', el)
          .clone()
          .children()
          .remove()
          .end()
          .text()
          .trim();

        showcases.push({
          description,
          image,
          name,
          slug
        });
      });

      return $(
        'body > div.application-main > div.container-md.p-responsive.py-6 > form > input[type="hidden"]:nth-child(2)'
      ).attr('value');
    };

    const res1 = await request({
      method: 'GET',
      url: 'https://github.com/collections'
    });

    const after = addShowcases(res1);

    if (after) {
      const res2 = await request({
        method: 'GET',
        qs: { after },
        url: 'https://github.com/collections'
      });

      addShowcases(res2);
    }

    return showcases;
  }

  public async getShowcaseRepositories(slug: string) {
    const res = await request({
      method: 'GET',
      url: `https://github.com/collections/${slug}`
    });

    const $ = cheerio.load(res);

    const data: Array<{ owner: string; name: string }> = [];

    $('article').each((idx, el) => {
      const [, owner, name] = $('h1 > a', el)
        .attr('href')
        .split('/');

      if (!owner || !name) {
        return;
      }

      data.push({ owner, name });
    });

    const repos: any[] = [];
    for (const d of data) {
      const repo = await this.getRepository(d.owner, d.name);
      repos.push(repo);
    }

    return repos;
  }
}
