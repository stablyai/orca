// One batch of id lookups reads each owner repo once, and answers every id exactly as a lone lookup does.
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { mergeWorktreeMetaForWrite } from '../../../persistence/loading-store/worktree-metadata/worktree-meta-write-normalization'
import type { RepoWorktreeRow, RepoWorktreeRowDeps } from './repo-worktree-row-resolution'
import {
  createScopedWorktreeReads,
  resolveScopedWorktreeIdRow
} from './scoped-worktree-row-resolution'

const local: Repo = {
  id: 'repo-local',
  path: '/work/app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git'
}
const remote: Repo = { ...local, id: 'repo-remote', path: '/srv/app', connectionId: 'ssh-box' }

function checkout(path: string, branch: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: `head-${branch}`, branch, isBare: false, isMainWorktree }
}

const SCANS: Record<string, GitWorktreeInfo[]> = {
  [local.id]: [
    checkout('/work/app', 'main', true),
    checkout('/work/app-wt/one', 'one'),
    checkout('/work/app-wt/two', 'two')
  ],
  [remote.id]: [checkout('/srv/app', 'main', true), checkout('/srv/app-wt/far', 'far')]
}

function harness(): { deps: RepoWorktreeRowDeps; scans: Map<string, number> } {
  const meta = new Map<string, WorktreeMeta>()
  const scans = new Map<string, number>()
  const write = (id: string, hostId: ExecutionHostId): WorktreeMeta => {
    // The store's own merge, with the fields it would randomize pinned so both runs compare.
    const row = mergeWorktreeMetaForWrite(meta.get(id), {
      hostId,
      instanceId: `instance:${id}`,
      sortOrder: 0
    })
    meta.set(id, row)
    return row
  }
  const store = {
    getRepos: () => [local, remote],
    getRepo: (id: string) => [local, remote].find((repo) => repo.id === id),
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => Object.fromEntries(meta),
    getAllWorktreeMetaForHost: () => Object.fromEntries(meta),
    getWorktreeMeta: (id: string) => meta.get(id),
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) => {
      const row = meta.get(id)
      return row && (!row.hostId || row.hostId === hostId) ? row : undefined
    },
    setWorktreeMeta: (target: { id: string; hostId: ExecutionHostId }) =>
      write(target.id, target.hostId),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: () => {}
  }
  const deps = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the accessors above.
    store: store as unknown as RepoWorktreeRowDeps['store'],
    scanRepo: async (repo: Repo) => {
      scans.set(repo.id, (scans.get(repo.id) ?? 0) + 1)
      return { ok: true, worktrees: SCANS[repo.id] ?? [] }
    },
    listFolderWorkspaces: () => []
  } satisfies RepoWorktreeRowDeps
  return { deps, scans }
}

// Present, a deleted checkout, one on another host's repo, and an unregistered repo.
const IDS = [
  `${local.id}::/work/app-wt/one`,
  `${local.id}::/work/app-wt/two`,
  `${local.id}::/work/app-wt/deleted`,
  `${remote.id}::/srv/app-wt/far`,
  `${remote.id}::/srv/app-wt/missing`,
  'repo-unknown::/elsewhere/wt'
]

describe('resolveScopedWorktreeIdRow with one batch of reads', () => {
  it('answers each id as a lone lookup does, reading each owner repo once', async () => {
    const alone = harness()
    const expected: (RepoWorktreeRow | null)[] = []
    for (const id of IDS) {
      expected.push(await resolveScopedWorktreeIdRow(alone.deps, id))
    }
    const batched = harness()
    const reads = createScopedWorktreeReads()
    const actual = await Promise.all(
      IDS.map((id) => resolveScopedWorktreeIdRow(batched.deps, id, undefined, reads))
    )

    expect(actual).toEqual(expected)
    expect(expected.map((row) => row?.id ?? null)).toEqual([
      IDS[0],
      IDS[1],
      null,
      IDS[3],
      null,
      null
    ])
    expect(alone.scans).toEqual(
      new Map([
        [local.id, 3],
        [remote.id, 2]
      ])
    )
    expect(batched.scans).toEqual(
      new Map([
        [local.id, 1],
        [remote.id, 1]
      ])
    )
  })
})
