import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { selectHostBalancedPage } from '../../shared/host-balanced-listing-page'
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
    // Why #18104: 497 local + 24 SSH rows, SSH at indices 496-520, and a 200-row cap returned
    // `{local: 200}` — zero of 24 remote worktrees, with nothing saying the gap was a whole host.
    const result = await queries(fleet(497, 24)).list(undefined, 200)

    expect(result.totalCount).toBe(521)
    expect(result.truncated).toBe(true)
    expect(result.worktrees).toHaveLength(200)
    const remote = result.worktrees.filter((row) => row.hostId === 'ssh:box-1')
    expect(remote).toHaveLength(24)
    expect(result.hostScope).toEqual({ hostIds: ['local', 'ssh:box-1'], omittedHostIds: [] })
  })

  it('keeps the page a subsequence of the unbounded listing', async () => {
    // Why: balancing decides which rows survive the cap, never how the survivors are ordered.
    const resolved = fleet(497, 24)
    const result = await queries(resolved).list(undefined, 200)

    const positions = result.worktrees.map((row) => resolved.findIndex((it) => it.id === row.id))
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('names a configured host that contributed no rows at all', async () => {
    // Why: a repo whose scan failed contributes zero rows exactly like a host with no worktrees.
    // docs/reference/ssh-execution-boundary.md forbids the listing from reading as absolute there.
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
    // Why: the caller scoped this themselves, so naming the hosts they excluded is noise.
    const result = await queries(fleet(0, 5)).list('id:repo-ssh', 200)

    expect(result.hostScope).toEqual({ hostIds: ['ssh:box-1'], omittedHostIds: [] })
  })

  it('leaves an uncapped listing byte-identical', async () => {
    const resolved = fleet(4, 2)
    const result = await queries(resolved).list(undefined, 200)

    expect(result.worktrees.map((row) => row.id)).toEqual(resolved.map((row) => row.id))
    expect(result.truncated).toBe(false)
  })
})

describe('selectHostBalancedPage', () => {
  it('gives every host a share of the cap rather than filling it from the first', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) => ({ host: 'local', index })),
      ...Array.from({ length: 10 }, (_, index) => ({ host: 'ssh:box-1', index: index + 10 }))
    ]

    const page = selectHostBalancedPage(rows, 4, (row) => row.host)

    expect(page.map((row) => row.host)).toEqual(['local', 'local', 'ssh:box-1', 'ssh:box-1'])
  })

  it('fills the cap from the remaining hosts when one runs out of rows', () => {
    const rows = [
      { host: 'local', id: 'a' },
      { host: 'local', id: 'b' },
      { host: 'local', id: 'c' },
      { host: 'ssh:box-1', id: 'd' }
    ]

    const page = selectHostBalancedPage(rows, 3, (row) => row.host)

    expect(page.map((row) => row.id)).toEqual(['a', 'b', 'd'])
  })

  it('buckets rows with no host together instead of dropping them', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    expect(selectHostBalancedPage(rows, 2, () => undefined).map((row) => row.id)).toEqual([
      'a',
      'b'
    ])
  })
})
