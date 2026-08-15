import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { fanOutSmartSearch } from './smart-source-fan-out'

type Call = { method: string; params: Record<string, unknown> }

function fakeClient(byMethod: Record<string, unknown>, calls: Call[]): RpcClient {
  return {
    sendRequest: async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const result = byMethod[method]
      if (result instanceof Error) {
        return {
          id: '1',
          ok: false,
          error: { code: 'x', message: result.message },
          _meta: { runtimeId: 'r' }
        }
      }
      return { id: '1', ok: true, result: result ?? { items: [] }, _meta: { runtimeId: 'r' } }
    }
  } as unknown as RpcClient
}

const smartArgs = {
  mode: 'smart' as const,
  query: 'bug',
  repoId: 'repo-1',
  githubAvailable: true,
  gitlabAvailable: true,
  linearAvailable: true,
  planeAvailable: true,
  mrStateFilter: 'opened' as const,
  linearWorkspaceId: null,
  planeInstanceId: null
}

describe('fanOutSmartSearch', () => {
  it('fans out to every provider in smart mode and stamps repoId', async () => {
    const calls: Call[] = []
    const client = fakeClient(
      {
        'github.listWorkItems': { items: [{ id: 'g1', type: 'issue', number: 1, title: 'A' }] },
        'gitlab.listWorkItems': { items: [{ id: 'gl1', type: 'mr', number: 2, title: 'B' }] },
        'linear.searchIssues': { items: [{ id: 'l1', identifier: 'ENG-1', title: 'C' }] },
        'plane.searchIssues': { items: [{ id: 'p1', identifier: 'AIF-1', title: 'D' }] },
        'repo.searchRefs': { refDetails: [{ refName: 'main', localBranchName: 'main' }] }
      },
      calls
    )
    const result = await fanOutSmartSearch({ client, ...smartArgs })
    expect(calls.map((c) => c.method).sort()).toEqual([
      'github.listWorkItems',
      'gitlab.listWorkItems',
      'linear.searchIssues',
      'plane.searchIssues',
      'repo.searchRefs'
    ])
    expect(result.githubItems[0]).toMatchObject({ number: 1, repoId: 'repo-1' })
    expect(result.gitlabItems[0]).toMatchObject({ number: 2, repoId: 'repo-1' })
    expect(result.linearIssues[0]).toMatchObject({ identifier: 'ENG-1' })
    expect(result.planeIssues[0]).toMatchObject({ identifier: 'AIF-1' })
    expect(result.branches).toEqual([{ refName: 'main', localBranchName: 'main' }])
    expect(result.error).toBe('')
  })

  it('swallows a single provider failure in smart mode (best-effort)', async () => {
    const calls: Call[] = []
    const client = fakeClient(
      {
        'github.listWorkItems': new Error('gh down'),
        'gitlab.listWorkItems': { items: [{ id: 'gl1', type: 'mr', number: 2, title: 'B' }] },
        'linear.searchIssues': { items: [] },
        'plane.searchIssues': { items: [] },
        'repo.searchRefs': { refDetails: [] }
      },
      calls
    )
    const result = await fanOutSmartSearch({ client, ...smartArgs })
    expect(result.error).toBe('')
    expect(result.gitlabItems).toHaveLength(1)
  })

  it('surfaces the error for a single-provider mode', async () => {
    const calls: Call[] = []
    const client = fakeClient({ 'gitlab.listWorkItems': new Error('gl boom') }, calls)
    const result = await fanOutSmartSearch({ ...smartArgs, mode: 'gitlab', client })
    expect(calls.map((c) => c.method)).toEqual(['gitlab.listWorkItems'])
    expect(result.error).toBe('gl boom')
  })

  it('only searches branches in smart mode when the query is non-empty', async () => {
    const calls: Call[] = []
    const client = fakeClient({}, calls)
    await fanOutSmartSearch({ ...smartArgs, query: '', client })
    expect(calls.map((c) => c.method)).not.toContain('repo.searchRefs')
  })

  it('skips GitHub in smart mode when GitHub is unavailable', async () => {
    const calls: Call[] = []
    const client = fakeClient({}, calls)
    await fanOutSmartSearch({ ...smartArgs, githubAvailable: false, client })
    expect(calls.map((c) => c.method)).not.toContain('github.listWorkItems')
  })

  it('does not send oversized source queries to any provider', async () => {
    const calls: Call[] = []
    const client = fakeClient({}, calls)
    const result = await fanOutSmartSearch({ ...smartArgs, query: 'x'.repeat(2049), client })
    expect(calls).toEqual([])
    expect(result).toMatchObject({
      githubItems: [],
      gitlabItems: [],
      linearIssues: [],
      planeIssues: [],
      branches: []
    })
  })

  it('lists assigned Plane issues for empty Plane queries', async () => {
    const calls: Call[] = []
    const client = fakeClient({ 'plane.listIssues': { items: [{ id: 'p1', identifier: 'AIF-2' }] } }, calls)
    const result = await fanOutSmartSearch({ ...smartArgs, mode: 'plane', query: '', client })
    expect(calls).toEqual([
      { method: 'plane.listIssues', params: { filter: 'assigned', limit: 50, instanceId: undefined } }
    ])
    expect(result.planeIssues[0]).toMatchObject({ identifier: 'AIF-2' })
  })
})
