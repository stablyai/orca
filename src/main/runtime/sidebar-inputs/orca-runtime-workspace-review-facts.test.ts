// Runs on plain Node, as orcad does: facts come from the host's persisted PR cache.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

function withSidebarFacts(runtime: OrcaRuntimeService) {
  const facts = runtime.sidebarFacts
  if (!facts) {
    throw new Error('built without the sidebar facts layer')
  }
  return facts
}

const repo = { id: 'repo-1', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }

function worktree(id: string, branch: string): ResolvedWorktree {
  return {
    id,
    repoId: repo.id,
    path: id,
    branch,
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path: id, head: '', branch, isBare: false, isMainWorktree: false }
  }
}

describe('getWorkspaceReviewFacts', () => {
  it('keys the persisted PR cache by workspace row', async () => {
    const merged: PRInfo = {
      number: 3,
      title: 'Ship it',
      state: 'merged',
      url: 'https://github.com/o/r/pull/3',
      checksStatus: 'success',
      updatedAt: '2026-10-17T00:00:00Z',
      mergeable: 'UNKNOWN'
    }
    const pr = { 'repo-1::a': { data: merged, fetchedAt: 1 } }
    const store: Pick<RuntimeStore, 'getRepos' | 'getGitHubCache'> = {
      getRepos: () => [repo],
      getGitHubCache: () => ({ pr, issue: {} })
    }
    class Probe extends OrcaRuntimeService {
      protected override async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
        return {
          worktrees: [worktree('repo-1::/r/a', 'refs/heads/a'), worktree('repo-1::/r/b', 'b')],
          platformByRepoId: new Map()
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read touches only repos and the GitHub cache.
    const runtime = withSidebarFacts(new Probe(store as RuntimeStore))
    await expect(runtime.getWorkspaceReviewFacts()).resolves.toEqual({
      facts: { '|repo-1::/r/a': { provider: 'github', reviewState: 'merged' } }
    })
  })

  it('publishes nothing without a store', async () => {
    await expect(
      withSidebarFacts(new OrcaRuntimeService()).getWorkspaceReviewFacts()
    ).resolves.toEqual({
      facts: {}
    })
  })
})
