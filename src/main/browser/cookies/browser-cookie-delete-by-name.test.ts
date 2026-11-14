import { describe, expect, it } from 'vitest'
import { deleteCookieByName } from './browser-cookie-delete-by-name'

const partitionKey = { topLevelSite: 'https://example.org', hasCrossSiteAncestor: true }
const COOKIES = [
  { name: 'sid', domain: '.example.com', path: '/' },
  { name: 'sid', domain: 'example.com', path: '/account' },
  { name: 'sid', domain: 'example.com', path: '/', partitionKey },
  { name: 'sid', domain: 'www.example.com', path: '/' },
  { name: 'sid', domain: 'example.net', path: '/' },
  { name: 'sid', domain: 'example.com', path: '/', partitionKeyOpaque: true },
  { name: 'keep', domain: '.example.com', path: '/' }
]

async function deleteSid(target: Parameters<typeof deleteCookieByName>[2]) {
  const deletes: Record<string, unknown>[] = []
  const result = await deleteCookieByName(
    async (method, params) => {
      if (method === 'Network.getAllCookies') {
        return { cookies: COOKIES }
      }
      deletes.push({ method, ...params })
      return {}
    },
    'sid',
    target
  )
  return { result, deletes }
}

describe('deleteCookieByName', () => {
  it('deletes host-only and dot-prefixed cookies on the given domain', async () => {
    const { result, deletes } = await deleteSid({
      domain: '.Example.COM',
      pageUrl: 'https://ignored.test/'
    })

    expect(result).toEqual({ deleted: true })
    expect(deletes).toEqual([
      { method: 'Network.deleteCookies', name: 'sid', domain: '.example.com', path: '/' },
      { method: 'Network.deleteCookies', name: 'sid', domain: 'example.com', path: '/account' },
      {
        method: 'Network.deleteCookies',
        name: 'sid',
        domain: 'example.com',
        path: '/',
        partitionKey
      }
    ])
  })

  it('deletes cookies the URL host would receive, including parent-domain cookies', async () => {
    const { deletes } = await deleteSid({
      url: 'https://www.example.com/app',
      pageUrl: 'https://ignored.test/'
    })

    expect(deletes.map(({ domain }) => domain)).toEqual(['.example.com', 'www.example.com'])
  })
})
