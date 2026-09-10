import { afterEach, describe, expect, it, vi } from 'vitest'
import { listMcpIssues } from './mcp-issue-list'
import { createPageRecovery, encodePageRecovery } from './mcp-issue-list-recovery'

const fixture = vi.hoisted(() => ({
  workspaces: Array.from({ length: 32 }, (_, i) => ({
    id: String(i).padStart(2, '0'),
    organizationId: String(i),
    organizationName: 'Fixture',
    displayName: 'Fixture',
    email: null,
    credentialRevision: 1
  }))
}))
vi.mock('./client', () => ({
  getStatus: () => ({ workspaces: fixture.workspaces }),
  getClients: (id: string) => [
    {
      workspace: fixture.workspaces.find((w) => w.id === id),
      client: { options: { apiKey: 'synthetic' } },
      apiKey: 'synthetic'
    }
  ]
}))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

describe('prospective page recovery metadata', () => {
  it('refuses legitimate cursor growth across64KiB before rows or cursor commit', async () => {
    const request = { workspaceId: 'all', limit: 1, pageRecovery: { version: 1 as const } }
    const state = createPageRecovery(request, fixture.workspaces)
    for (let index = 1; index < state.workspaces.length; index++) {
      const remaining = 64_000 - encodePageRecovery(state).length
      const length = Math.min(2048, Math.max(0, Math.floor(remaining * 0.75) - 40))
      if (length) {
        state.workspaces[index].after = 'x'.repeat(length)
      }
    }
    const continuation = encodePageRecovery(state)
    expect(continuation.length).toBeGreaterThan(63_500)
    expect(continuation.length).toBeLessThan(65_536)
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          issues: {
            nodes: [
              {
                id: 'issue',
                identifier: 'F-1',
                title: 'Full issue',
                url: 'https://linear.app/fixture'
              }
            ],
            pageInfo: { hasNextPage: true, endCursor: 'y'.repeat(2048) }
          }
        }
      })
    )
    vi.stubGlobal('fetch', fetch)
    const failure = await listMcpIssues({
      ...request,
      pageRecovery: { version: 1, continuation }
    }).catch((error) => error)
    expect(failure.code).toBe('linear_list_metadata_capacity')
    const recovered = JSON.parse(
      Buffer.from(failure.data.pageRecovery.continuation, 'base64url').toString()
    )
    expect(recovered.workspaces).toEqual(state.workspaces)
    expect(recovered.nextWorkspaceIndex).toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects a stale account revision before any provider request', async () => {
    const request = { workspaceId: 'all', pageRecovery: { version: 1 as const } }
    const state = createPageRecovery(request, fixture.workspaces)
    state.workspaces[0].credentialRevision++
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      listMcpIssues({
        ...request,
        pageRecovery: { version: 1, continuation: encodePageRecovery(state) }
      })
    ).rejects.toMatchObject({ code: 'linear_list_stale_recovery' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
