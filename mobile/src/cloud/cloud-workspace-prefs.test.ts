import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('./cloud-session', () => ({ loadCloudControlPlane: vi.fn() }))

import { setPinned } from '../../../src/shared/cloud-workspaces/cloud-workspace-arrangement'
import { editCloudWorkspacePrefsOn, resolveCloudWorkspaceLink } from './cloud-workspace-prefs'
import type { CloudControlPlane } from './cloud-control-plane-request'

const PutBody = z.object({
  document: z.object({
    pinned: z.array(z.string()),
    order: z.array(z.string()),
    sections: z.array(z.string()),
    collapsed: z.array(z.string())
  }),
  revision: z.number()
})

const A = `sbx_${'a'.repeat(24)}`
const B = `sbx_${'b'.repeat(24)}`

function plane(handler: (method: string, url: URL, body: unknown) => [number, unknown]) {
  const calls: string[] = []
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push(`${init.method} ${url.pathname}${url.search}`)
    const [status, body] = handler(
      init.method ?? 'GET',
      url,
      init.body ? JSON.parse(String(init.body)) : undefined
    )
    return new Response(JSON.stringify(body), { status })
  }
  const p: CloudControlPlane = { baseUrl: 'https://cp.example', token: () => 't', fetch: fetchFn }
  return { plane: p, calls }
}

describe('phone prefs sync', () => {
  it('re-applies a pin on top of a desktop that wrote first', async () => {
    let server: z.infer<typeof PutBody> = {
      document: { pinned: [B], order: [], sections: [], collapsed: [] },
      revision: 3
    }
    let firstPut = true
    const { plane: p, calls } = plane((method, _url, body) => {
      if (method === 'GET') {
        return [200, { ...server, updatedAt: 1 }]
      }
      const put = PutBody.parse(body)
      if (firstPut) {
        // A desktop wrote between our read and our write.
        firstPut = false
        server = { ...server, revision: 4 }
        return [409, { error: 'conflict', reason: 'stale_revision' }]
      }
      expect(put.revision).toBe(4)
      server = { document: put.document, revision: 5 }
      return [200, { ...server, updatedAt: 2 }]
    })
    const saved = await editCloudWorkspacePrefsOn(p, (doc) => setPinned(doc, A, true))
    expect(saved.document.pinned).toEqual([B, A])
    expect(calls).toEqual([
      'GET /v1/team/prefs',
      'PUT /v1/team/prefs',
      'GET /v1/team/prefs',
      'PUT /v1/team/prefs'
    ])
  })

  it('resolves number links and treats not found as null', async () => {
    const { plane: p, calls } = plane((_method, url) =>
      url.searchParams.get('n') === '7'
        ? [200, { workspace: { id: A }, chatId: null }]
        : [404, { error: 'not_found' }]
    )
    await expect(
      resolveCloudWorkspaceLink(p, { kind: 'number', org: 'acme', number: 8 })
    ).resolves.toBeNull()
    expect(calls).toEqual(['GET /v1/team/links/resolve?org=acme&n=8'])
    await expect(resolveCloudWorkspaceLink(p, { kind: 'id', workspaceId: B })).resolves.toBe(B)
  })
})
