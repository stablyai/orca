import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>())
vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('./doc-preview-protocol', () => ({
  handleDocPreviewRequest: async (incoming: Request) =>
    new URL(incoming.url).pathname === '/docs/clip.mp4'
      ? new Response('0123456789', { headers: { 'Content-Type': 'video/mp4' } })
      : new Response('<h1>page</h1>', { headers: { 'Content-Type': 'text/html' } })
}))

import { mintDocPreviewGrant, revokeDocPreviewGrant } from './doc-preview-grant-registry'
import { openDocPreviewInSystemBrowser } from './doc-preview-loopback-server'

function get(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; range?: string }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          range: response.headers['content-range']
        })
      )
    })
      .on('error', reject)
      .end()
  })
}

function mint(browserPageId: string) {
  return mintDocPreviewGrant({
    owner: {
      kind: 'runtime',
      environmentId: 'env',
      worktreeSelector: 'id:wt',
      worktreeRoot: '/repo'
    },
    requestBase: '/repo',
    root: '/repo/docs',
    entryRelativePath: 'docs/index.html',
    browserPageId
  })
}

afterEach(() => openExternal.mockReset())

describe('openDocPreviewInSystemBrowser', () => {
  it('streams only opted-in live grants to loopback, with byte ranges', async () => {
    const grant = mint('page-a')
    const other = mint('page-b')
    expect(await openDocPreviewInSystemBrowser(grant.id)).toBe(true)
    const entryUrl = openExternal.mock.calls[0][0]
    expect(entryUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${grant.id}/docs/index\\.html$`)
    )
    const origin = new URL(entryUrl).origin

    expect(await get(entryUrl)).toMatchObject({ status: 200, body: '<h1>page</h1>' })
    expect(await get(`${origin}/${grant.id}/docs/clip.mp4`, { Range: 'bytes=2-5' })).toEqual({
      status: 206,
      body: '2345',
      range: 'bytes 2-5/10'
    })
    expect((await get(`${origin}/${other.id}/docs/index.html`)).status).toBe(404)
    expect((await get(entryUrl, { Host: `evil.test:${new URL(entryUrl).port}` })).status).toBe(403)

    revokeDocPreviewGrant(grant.id)
    expect((await get(entryUrl)).status).toBe(404)
  })
})
