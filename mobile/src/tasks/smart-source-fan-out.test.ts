import { describe, expect, it } from 'vitest'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import { fanOutSmartSearch } from './smart-source-fan-out'

type Call = { method: string; params: Record<string, unknown> }

function fakeOperations(
  byMethod: Record<string, unknown>,
  calls: Call[]
): HostWorkspaceCreationOperations {
  const invoke = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params })
    const result = byMethod[method]
    if (result instanceof Error) {
      throw result
    }
    return result as T
  }
  return {
    searchGitHubItems: async (repoId, query) => {
      const result = await invoke<{ items?: never[] }>('github.listWorkItems', { repoId, query })
      return (result?.items ?? []).map((item) => ({ ...item, repoId }))
    },
    searchGitLabItems: async (repoId, query, state) => {
      const result = await invoke<{ items?: never[] }>('gitlab.listWorkItems', {
        repoId,
        query,
        state
      })
      return (result?.items ?? []).map((item) => ({ ...item, repoId }))
    },
    searchLinearIssues: async (query, linearWorkspaceId) => {
      const result = await invoke<{ items?: never[] }>('linear.searchIssues', {
        query,
        linearWorkspaceId
      })
      return result?.items ?? []
    },
    searchBranches: async (repoId, query) => {
      const result = await invoke<{ refDetails?: never[] }>('repo.searchRefs', { repoId, query })
      return result?.refDetails ?? []
    }
  } as unknown as HostWorkspaceCreationOperations
}

const smartArgs = {
  mode: 'smart' as const,
  query: 'bug',
  repoId: 'repo-1',
  githubAvailable: true,
  gitlabAvailable: true,
  linearAvailable: true,
  mrStateFilter: 'opened' as const,
  linearWorkspaceId: null
}

describe('fanOutSmartSearch', () => {
  it('fans out to every provider in smart mode and stamps repoId', async () => {
    const calls: Call[] = []
    const operations = fakeOperations(
      {
        'github.listWorkItems': { items: [{ id: 'g1', type: 'issue', number: 1, title: 'A' }] },
        'gitlab.listWorkItems': { items: [{ id: 'gl1', type: 'mr', number: 2, title: 'B' }] },
        'linear.searchIssues': { items: [{ id: 'l1', identifier: 'ENG-1', title: 'C' }] },
        'repo.searchRefs': { refDetails: [{ refName: 'main', localBranchName: 'main' }] }
      },
      calls
    )
    const result = await fanOutSmartSearch({ operations, ...smartArgs })
    expect(calls.map((c) => c.method).sort()).toEqual([
      'github.listWorkItems',
      'gitlab.listWorkItems',
      'linear.searchIssues',
      'repo.searchRefs'
    ])
    expect(result.githubItems[0]).toMatchObject({ number: 1, repoId: 'repo-1' })
    expect(result.gitlabItems[0]).toMatchObject({ number: 2, repoId: 'repo-1' })
    expect(result.linearIssues[0]).toMatchObject({ identifier: 'ENG-1' })
    expect(result.branches).toEqual([{ refName: 'main', localBranchName: 'main' }])
    expect(result.error).toBe('')
  })

  it('swallows a single provider failure in smart mode (best-effort)', async () => {
    const calls: Call[] = []
    const operations = fakeOperations(
      {
        'github.listWorkItems': new Error('gh down'),
        'gitlab.listWorkItems': { items: [{ id: 'gl1', type: 'mr', number: 2, title: 'B' }] },
        'linear.searchIssues': { items: [] },
        'repo.searchRefs': { refDetails: [] }
      },
      calls
    )
    const result = await fanOutSmartSearch({ operations, ...smartArgs })
    expect(result.error).toBe('')
    expect(result.gitlabItems).toHaveLength(1)
  })

  it('surfaces the error for a single-provider mode', async () => {
    const calls: Call[] = []
    const operations = fakeOperations({ 'gitlab.listWorkItems': new Error('gl boom') }, calls)
    const result = await fanOutSmartSearch({ ...smartArgs, mode: 'gitlab', operations })
    expect(calls.map((c) => c.method)).toEqual(['gitlab.listWorkItems'])
    expect(result.error).toBe('gl boom')
  })

  it('only searches branches in smart mode when the query is non-empty', async () => {
    const calls: Call[] = []
    const operations = fakeOperations({}, calls)
    await fanOutSmartSearch({ ...smartArgs, query: '', operations })
    expect(calls.map((c) => c.method)).not.toContain('repo.searchRefs')
  })

  it('skips GitHub in smart mode when GitHub is unavailable', async () => {
    const calls: Call[] = []
    const operations = fakeOperations({}, calls)
    await fanOutSmartSearch({ ...smartArgs, githubAvailable: false, operations })
    expect(calls.map((c) => c.method)).not.toContain('github.listWorkItems')
  })

  it('does not send oversized source queries to any provider', async () => {
    const calls: Call[] = []
    const operations = fakeOperations({}, calls)
    const result = await fanOutSmartSearch({
      ...smartArgs,
      query: 'x'.repeat(2049),
      operations
    })
    expect(calls).toEqual([])
    expect(result).toMatchObject({
      githubItems: [],
      gitlabItems: [],
      linearIssues: [],
      branches: []
    })
  })
})
