import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { formatRemoteLinearCli } from '../ssh/ssh-remote-linear-output'
import { listMcpIssues } from './mcp-issue-list'
import { IssueListLifetime } from './mcp-issue-list-lifetime'
import { acquireIssueListPage } from './mcp-issue-list-acquisition'
import { invalidateLinearAccountReads } from './linear-account-read-lifetime'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'

// Synthetic account adapter models registry removal; acquisition and ownership are real.
const fixture = vi.hoisted(() => ({ workspaces: [] as LinearWorkspace[], cleared: [] as string[] }))
vi.mock('./client', () => ({
  getStatus: () => ({ workspaces: fixture.workspaces }),
  getClients: (id: string) =>
    fixture.workspaces
      .filter((w) => w.id === id)
      .map((workspace) => ({
        workspace,
        client: { options: { apiKey: workspace.id } }
      }))
}))
vi.mock('./linear-token-store', async () => {
  const { invalidateLinearAccountReads } = await import('./linear-account-read-lifetime')
  return {
    clearToken: (id: string) => {
      fixture.cleared.push(id)
      invalidateLinearAccountReads(id)
      fixture.workspaces = fixture.workspaces.filter((w) => w.id !== id)
    }
  }
})
const workspace = (id: string): LinearWorkspace => ({
  id,
  organizationId: id,
  organizationName: id,
  displayName: id,
  email: null,
  credentialRevision: 1
})
const row = (id: string) => ({ id, identifier: id, title: id, url: 'https://linear.app/fixture' })
const page = (id: string, more = false, cursor?: string) =>
  Response.json({
    data: { issues: { nodes: [row(id)], pageInfo: { hasNextPage: more, endCursor: cursor } } }
  })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
beforeEach(() => {
  fixture.workspaces = ['a', 'b'].map(workspace)
  fixture.cleared = []
})
afterEach(() => vi.unstubAllGlobals())

it.each([false, true])(
  'HTTP401 mutation authority with replacement=%s and held cancellation',
  async (replacement) => {
    const cancel = deferred()
    const cancelling = deferred()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelling.resolve()
              return cancel.promise
            }
          }),
          { status: 401 }
        )
    )
    const owner = new IssueListLifetime()
    const observed = owner
      .read('a', (signal) => acquireIssueListPage({ apiKey: 'synthetic' }, { first: 1 }, signal))
      .catch((error) => error)
    try {
      await cancelling.promise
      if (replacement) {
        invalidateLinearAccountReads('a')
        fixture.workspaces[0] = { ...workspace('a'), credentialRevision: 2 }
        expect((await observed).code).toBe('linear_list_stale_recovery')
        owner.finish()
        expect(owner.cleanupPending).toBe(true)
      }
      cancel.resolve()
      if (!replacement) {
        expect((await observed).code).toBe('linear_auth_expired')
      }
      await vi.waitFor(() => expect(owner.cleanupPending).toBe(false))
      expect(fixture.cleared).toEqual(replacement ? [] : ['a'])
      expect(fixture.workspaces.map((w) => w.id)).toEqual(replacement ? ['a', 'b'] : ['b'])
    } finally {
      cancel.resolve()
      owner.finish()
      await observed
    }
  }
)

it('delivers healthy pages after auth removal and resumes both concrete positions after reconnect', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const id = new Headers(init.headers).get('Authorization')!
    calls.push(id)
    return id === 'a' ? new Response(null, { status: 401 }) : page('b-1', true, 'b-after')
  })
  const request = { workspaceId: 'all', limit: 1, pageRecovery: { version: 1 as const } }
  const result = await listMcpIssues(request)
  expect(calls).toEqual(['a', 'b'])
  expect(result.issues.map((r) => r.id)).toEqual(['b-1'])
  expect(result.meta).toMatchObject({
    partial: true,
    hasMore: true,
    workspaceErrors: [{ code: 'linear_auth_expired' }]
  })
  expect(result.meta.pageRecovery).toBeUndefined()
  const recovery = result.meta.concreteRecovery!
  expect(recovery).toEqual([
    { workspaceId: 'a', done: false },
    { workspaceId: 'b', cursor: expect.any(String), done: false }
  ])
  fixture.workspaces.push({ ...workspace('a'), credentialRevision: 2 })
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const id = new Headers(init.headers).get('Authorization')!
    const variables = JSON.parse(String(init.body)).variables
    expect(variables.after).toBe(id === 'b' ? 'b-after' : undefined)
    return page(`${id}-2`)
  })
  const rows: string[] = []
  for (const { workspaceId, cursor } of recovery) {
    const next = await listMcpIssues({ workspaceId, cursor, limit: 1 })
    expect(next.meta.hasMore).toBe(false)
    rows.push(...next.issues.map((r) => r.id))
  }
  expect(rows).toEqual(['a-2', 'b-2'])
})

it('still refuses a replacement healthy account before page commit after auth removal', async () => {
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    if (new Headers(init.headers).get('Authorization') === 'a') {
      return new Response(null, { status: 401 })
    }
    invalidateLinearAccountReads('b')
    fixture.workspaces[0] = { ...workspace('b'), credentialRevision: 2 }
    return page('unauthorized-late-row')
  })
  const error = await listMcpIssues({ workspaceId: 'all', pageRecovery: { version: 1 } }).catch(
    (error) => error
  )
  expect(error.issues).toBeUndefined()
  expect(error.code).toBe('linear_list_stale_recovery')
  expect(fixture.cleared).toEqual(['a'])
})

it.each(['a', 'all'])('preserves Retry-After17 through %s producer errors', async (workspaceId) => {
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) =>
    new Headers(init.headers).get('Authorization') === 'b'
      ? page('b-1')
      : new Response(null, { status: 429, headers: { 'retry-after': '17' } })
  )
  if (workspaceId === 'a') {
    await expect(listMcpIssues({ workspaceId })).rejects.toMatchObject({
      code: 'linear_rate_limited',
      data: { retryAfterSeconds: 17 }
    })
  } else {
    const result = await listMcpIssues({ workspaceId, pageRecovery: { version: 1 } })
    expect(result.meta.workspaceErrors[0].data).toMatchObject({ retryAfterSeconds: 17 })
  }
})

it('rejects cursor growth before admission when the complete next query would exceed64KiB', async () => {
  fixture.workspaces = Array.from({ length: 32 }, (_, i) => workspace(String(i).padStart(2, '0')))
  const fetch = vi.fn(async () => page('must-not-commit', true, 'c'.repeat(2048)))
  vi.stubGlobal('fetch', fetch)
  const request = {
    workspaceId: 'all',
    query: 'q'.repeat(61000),
    limit: 1,
    pageRecovery: { version: 1 as const }
  }
  const error = await listMcpIssues(request).catch((error) => error)
  expect(error.code).toBe('linear_list_metadata_capacity')
  expect(error.issues).toBeUndefined()
  expect(fetch).toHaveBeenCalledOnce()
  const next = { ...request, pageRecovery: error.data.pageRecovery }
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(65536)
  if (next.pageRecovery.continuation) {
    const positions = JSON.parse(
      Buffer.from(next.pageRecovery.continuation, 'base64url').toString()
    ).workspaces
    expect(positions.every((w: { after?: string }) => !w.after)).toBe(true)
  }
  vi.stubGlobal('fetch', async () => page('recovered', false))
  const recovered = await listMcpIssues(next)
  expect(recovered.issues.map((r) => r.id)).toEqual(['recovered'])
})

it('SSH human output includes both the admitted-batch continuation and workspace failures', () => {
  const result = formatRemoteLinearCli({
    issues: [row('b')],
    truncated: true,
    meta: {
      limit: 1,
      returned: 1,
      hasMore: true,
      partial: true,
      orderBy: 'updatedAt',
      workspaceId: 'all',
      workspaceErrors: [
        {
          workspace: { id: 'a', name: 'Account A' },
          code: 'linear_permission_denied',
          message: 'Linear provider request failed (HTTP 403).'
        }
      ],
      pageRecovery: {
        version: 1,
        continuation: 'synthetic-vector',
        ordering: 'admitted_batch',
        consistency: 'best_effort'
      }
    }
  })
  expect(result?.stderr).toContain('--page-recovery synthetic-vector')
  expect(result?.stderr).toMatch(/Account A.*403/)
})
