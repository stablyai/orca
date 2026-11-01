import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'

import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'

const LOCAL_REPO: Repo = {
  id: 'repo-local',
  path: '/workspace/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1
}

const SSH_REPO: Repo = {
  ...LOCAL_REPO,
  id: 'repo-ssh',
  connectionId: 'box-1',
  displayName: 'app (remote)'
}

const settings = {
  workspaceDir: '/worktrees',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function worktree(repoId: string, path: string, hostId: string): ResolvedWorktree {
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    branch: 'main',
    hostId,
    displayName: path,
    comment: '',
    linkedIssue: null,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
  } as unknown as ResolvedWorktree
}

/** The reproduced shape from #18104: every remote row lands contiguously at the end. */
function fleet(localCount: number, sshCount: number): ResolvedWorktree[] {
  return [
    ...Array.from({ length: localCount }, (_, index) =>
      worktree(LOCAL_REPO.id, `/worktrees/local-${index}`, 'local')
    ),
    ...Array.from({ length: sshCount }, (_, index) =>
      worktree(SSH_REPO.id, `/remote/wt-${index}`, 'ssh:box-1')
    )
  ]
}

function queries(
  resolved: ResolvedWorktree[],
  knownHostIds: ExecutionHostId[] = ['local', 'ssh:box-1']
): RuntimeManagedWorktreeQueries {
  const store = {
    getRepos: () => [LOCAL_REPO, SSH_REPO],
    getRepo: () => LOCAL_REPO,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: () => ({}),
    getSettings: () => settings
  } as unknown as RuntimeStore
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => resolved,
    resolveRepo: async () => SSH_REPO,
    selectRepos: () => [SSH_REPO],
    scanRepo: async () => ({ ok: true, worktrees: [] }),
    listKnownHostIds: () => knownHostIds
  })
}

describe('worktree.list host coverage under the row cap', () => {
  it('returns remote rows that sit entirely past the cap', async () => {
    // #18104: the cap once returned 200 local rows and hid all 24 SSH worktrees.
    const result = await queries(fleet(497, 24)).list(undefined, 200)

    expect(result.totalCount).toBe(521)
    expect(result.truncated).toBe(true)
    expect(result.worktrees).toHaveLength(200)
    const remote = result.worktrees.filter((row) => row.hostId === 'ssh:box-1')
    expect(remote).toHaveLength(24)
    expect(result.hostScope).toEqual({ hostIds: ['local', 'ssh:box-1'], omittedHostIds: [] })
  })

  it('names a configured host that contributed no rows at all', async () => {
    // Failed repo scans and empty hosts both contribute no rows; scope must expose the uncertainty.
    const result = await queries(fleet(3, 0), ['local', 'ssh:box-1', 'runtime:paired']).list(
      undefined,
      200
    )

    expect(result.hostScope).toEqual({
      hostIds: ['local'],
      omittedHostIds: ['runtime:paired', 'ssh:box-1']
    })
  })

  it('does not report configured hosts as omitted from a --repo listing', async () => {
    // Caller-scoped listings must omit unrelated hosts.
    const result = await queries(fleet(0, 5)).list('id:repo-ssh', 200)

    expect(result.hostScope).toEqual({ hostIds: ['ssh:box-1'], omittedHostIds: [] })
  })
})
