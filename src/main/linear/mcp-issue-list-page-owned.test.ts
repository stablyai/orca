import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listMcpIssues } from './mcp-issue-list'
import { decodeIssueListCursor } from './mcp-issue-list-cursor'
import { invalidateLinearAccountReads } from './linear-account-read-lifetime'

const state = vi.hoisted(() => ({
  workspaces: [
    {
      id: 'a',
      organizationId: 'a',
      organizationName: 'A',
      displayName: 'A',
      email: null,
      credentialRevision: 1
    }
  ]
}))
vi.mock('./client', () => ({
  getStatus: () => ({ workspaces: state.workspaces, activeWorkspaceId: 'a' }),
  getClients: (id: string) =>
    state.workspaces
      .filter((w) => w.id === id)
      .map((workspace) => ({
        workspace,
        client: { options: { apiKey: workspace.id } },
        apiKey: workspace.id
      }))
}))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))

function row(id: number, size = 1) {
  return {
    id: String(id),
    identifier: `I-${id}`,
    title: 'Issue',
    url: 'https://linear.app/example',
    description: 'x'.repeat(size),
    updatedAt: '2026-01-01',
    priority: 2
  }
}
function provider(rows: ReturnType<typeof row>[]) {
  const calls: { first: number; after?: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const { variables } = JSON.parse(options.body)
      calls.push(variables)
      const offset = Number(variables.after ?? 0)
      const nodes = rows.slice(offset, offset + variables.first)
      return Response.json({
        data: {
          issues: {
            nodes,
            pageInfo: {
              hasNextPage: offset + nodes.length < rows.length,
              endCursor: String(offset + nodes.length)
            }
          }
        }
      })
    })
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
beforeEach(() => {
  state.workspaces = [
    {
      id: 'a',
      organizationId: 'a',
      organizationName: 'A',
      displayName: 'A',
      email: null,
      credentialRevision: 1
    }
  ]
})

describe('actual page-owned Linear producer', () => {
  it('walks omitted500 without a hidden250 limit and preserves full fields', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i))
    rows[8] = row(8, 130 * 1024)
    const calls = provider(rows)
    const result = await listMcpIssues({ workspaceId: 'a' })
    expect(result.issues).toHaveLength(500)
    expect(result.issues[8].description).toHaveLength(130 * 1024)
    expect(result.issues[8].priorityLabel).toBe('high')
    expect(result.meta.hasMore).toBe(false)
    expect(calls).toHaveLength(2)
  })
  it('preserves concrete v1 limit1 and exact exhaustion', async () => {
    provider([row(0), row(1)])
    const first = await listMcpIssues({ workspaceId: 'a', limit: 1 })
    expect(decodeIssueListCursor(first.meta.nextCursor!)?.cursor).toBe('1')
    const next = await listMcpIssues({ cursor: first.meta.nextCursor, limit: 1 })
    expect(next.issues[0].id).toBe('1')
    expect(next.meta.hasMore).toBe(false)
    expect(next.meta.nextCursor).toBeUndefined()
  })
  it('retries whole pages without gaps under heterogeneous byte pressure', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(i, i % 7 === 0 ? 130 * 1024 : 45 * 1024))
    const calls = provider(rows)
    const ids: string[] = []
    let cursor: string | undefined
    for (let invocation = 0; invocation < 30; invocation++) {
      const result = await listMcpIssues({ workspaceId: 'a', cursor })
      ids.push(...result.issues.map((issue) => issue.id))
      if (!result.meta.hasMore) {
        break
      }
      cursor = result.meta.nextCursor
      expect(cursor).toBeTruthy()
    }
    expect(ids).toEqual(rows.map((issue) => issue.id))
    expect(calls[0].first).toBe(250)
    expect(calls[1].after).toBeUndefined()
    expect(calls[1].first).toBeLessThan(250)
  })
  it('errors on a sole unrepresentable record and does not skip it', async () => {
    provider([row(0, 950 * 1024), row(1)])
    await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({
      code: 'linear_list_record_too_large',
      data: { retryPosition: { workspaceId: 'a' } }
    })
  })
  it('distinguishes unknown acquisition size from record size', async () => {
    provider([row(0, 5 * 1024 * 1024)])
    await expect(listMcpIssues({ workspaceId: 'a', limit: 1 })).rejects.toMatchObject({
      code: 'linear_list_acquisition_too_large'
    })
  })
  it.each([401, 403, 429, 503])('classifies HTTP %s before oversized body', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024), { status }))
    )
    const code =
      status === 401
        ? 'linear_auth_expired'
        : status === 403
          ? 'linear_permission_denied'
          : status === 429
            ? 'linear_rate_limited'
            : 'linear_network_error'
    await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({ code })
  })
  it('rejects invalid UTF8 before mapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0xff])))
    )
    await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({
      code: 'linear_list_invalid_response'
    })
  })
  it('distinguishes empty nonterminal page from exhaustion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } }
        })
      )
    )
    await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({
      code: 'linear_list_empty_page'
    })
    provider([])
    expect((await listMcpIssues({ workspaceId: 'a' })).meta.hasMore).toBe(false)
  })
  it('rotates all-workspace limit1 calls and explicitly refuses legacy incomplete-all', async () => {
    state.workspaces.push({ ...state.workspaces[0], id: 'b', organizationId: 'b' })
    provider([row(0)])
    await expect(listMcpIssues({ workspaceId: 'all', limit: 1 })).rejects.toMatchObject({
      code: 'linear_list_concrete_workspace_required'
    })
    const first = await listMcpIssues({
      workspaceId: 'all',
      limit: 1,
      pageRecovery: { version: 1 }
    })
    const second = await listMcpIssues({
      workspaceId: 'all',
      limit: 1,
      pageRecovery: { version: 1, continuation: first.meta.pageRecovery!.continuation }
    })
    expect(first.issues[0].workspace.id).toBe('a')
    expect(second.issues[0].workspace.id).toBe('b')
    expect(second.meta.hasMore).toBe(false)
  })
  it('rotates an actually timed-out workspace and resumes healthy work next call', async () => {
    vi.useFakeTimers()
    state.workspaces.push({ ...state.workspaces[0], id: 'b', organizationId: 'b' })
    let settle!: (value: Response) => void
    const held = new Promise<Response>((resolve) => {
      settle = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        if (options.headers.get('Authorization') === 'a') {
          return held
        }
        return Response.json({
          data: { issues: { nodes: [row(1)], pageInfo: { hasNextPage: false } } }
        })
      })
    )
    const pending = listMcpIssues({
      workspaceId: 'all',
      limit: 1,
      pageRecovery: { version: 1 }
    }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(20_001)
    const failure = await pending
    expect(failure.code).toBe('linear_timeout')
    const vector = JSON.parse(
      Buffer.from(failure.data.pageRecovery.continuation, 'base64url').toString()
    )
    expect(vector.nextWorkspaceIndex).toBe(1)
    expect(vector.workspaces[0]).not.toHaveProperty('after')
    const next = await listMcpIssues({
      workspaceId: 'all',
      limit: 1,
      pageRecovery: { version: 1, continuation: failure.data.pageRecovery.continuation }
    })
    expect(next.issues[0].workspace.id).toBe('b')
    settle(
      Response.json({ data: { issues: { nodes: [row(0)], pageInfo: { hasNextPage: false } } } })
    )
    await vi.advanceTimersByTimeAsync(1)
  })
  it.each([
    {},
    { data: { issues: null } },
    { data: { issues: { nodes: [], pageInfo: null } } },
    { data: { issues: { nodes: [row(0), row(1)], pageInfo: { hasNextPage: false } } } },
    { data: { issues: { nodes: [{ ...row(0), title: 3 }], pageInfo: { hasNextPage: false } } } }
  ])('rejects malformed or over-count provider pages without progress', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body))
    )
    await expect(listMcpIssues({ workspaceId: 'a', limit: 1 })).rejects.toMatchObject({
      code: 'linear_list_invalid_response',
      data: { retryPosition: { workspaceId: 'a' } }
    })
  })
  it.each([
    { cursors: [null], admitted: 0, code: 'linear_list_invalid_response' },
    { cursors: ['a', 'a'], admitted: 1, code: 'linear_list_cursor_cycle' },
    { cursors: ['a', 'b', 'a'], admitted: 2, code: 'linear_list_cursor_cycle' }
  ])(
    'diagnoses missing and cycling cursors without committing rejected rows',
    async ({ cursors, admitted, code }) => {
      let page = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const index = page++
          return Response.json({
            data: {
              issues: {
                nodes: [row(index)],
                pageInfo: { hasNextPage: true, endCursor: cursors[index] }
              }
            }
          })
        })
      )
      if (!admitted) {
        await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({ code })
      } else {
        const result = await listMcpIssues({ workspaceId: 'a' })
        expect(result.issues.map((issue) => issue.id)).toEqual(
          Array.from({ length: admitted }, (_, i) => String(i))
        )
        expect(result.meta.workspaceErrors[0].code).toBe(code)
        expect(decodeIssueListCursor(result.meta.nextCursor!)?.cursor).toBe(cursors[admitted - 1])
      }
      expect(page).toBe(admitted + 1)
    }
  )
  it('does not invent a failed workspace when the deadline expires before a turn starts', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20_001)
    const failure = await listMcpIssues({ workspaceId: 'all', pageRecovery: { version: 1 } }).catch(
      (error) => error
    )
    expect(failure.code).toBe('linear_timeout')
    const vector = JSON.parse(
      Buffer.from(failure.data.pageRecovery.continuation, 'base64url').toString()
    )
    expect(vector.nextWorkspaceIndex).toBe(0)
    expect(vector.workspaces[0]).not.toHaveProperty('after')
    expect(failure.data).not.toHaveProperty('workspaceErrors')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('suppresses a page invalidated during acquisition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        invalidateLinearAccountReads('a')
        return Response.json({
          data: { issues: { nodes: [row(0)], pageInfo: { hasNextPage: false } } }
        })
      })
    )
    await expect(listMcpIssues({ workspaceId: 'a' })).rejects.toMatchObject({
      code: 'linear_list_stale_recovery'
    })
  })
})
