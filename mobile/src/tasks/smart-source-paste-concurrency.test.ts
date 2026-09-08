import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import { useSmartWorkspaceSource } from './use-smart-workspace-source'

const REPOS = [{ id: 'repo-1', displayName: 'orca', slug: { owner: 'stablyai', repo: 'orca' } }]

function Probe(props: { operations: HostWorkspaceCreationOperations; query: string }) {
  useSmartWorkspaceSource({
    operations: props.operations,
    enabled: true,
    mode: 'smart',
    query: props.query,
    repoId: 'repo-1',
    githubAvailable: true,
    gitlabAvailable: false,
    linearAvailable: false,
    mrStateFilter: 'opened',
    repos: REPOS
  })
  return null
}

// The picker makes two independent host round trips for a pasted PR number: the
// provider fan-out and the exact-item lookup. Awaiting the fan-out first stacked
// them, so the rows appeared a whole extra round trip late.
describe('smart source paste lookup concurrency', () => {
  const mounted: ReactTestRenderer[] = []

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount()
      }
    })
    mounted.length = 0
    vi.useRealTimers()
  })

  it('issues the pasted-number lookup while the fan-out is still in flight', async () => {
    const sent: string[] = []
    const pendingOperation = (operation: string) => {
      sent.push(operation)
      return new Promise<never>(() => {})
    }
    const operations = {
      searchGitHubItems: () => pendingOperation('github.listWorkItems'),
      searchBranches: () => pendingOperation('repo.branches'),
      lookupGitHubItem: () => pendingOperation('github.workItem')
    } as unknown as HostWorkspaceCreationOperations

    await act(async () => {
      mounted.push(create(createElement(Probe, { operations, query: '16831' })))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(sent).toContain('github.listWorkItems')
    expect(sent).toContain('github.workItem')
  })
})
