import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type * as NodeCryptoModule from 'node:crypto'
import type * as OwnershipModule from '../../../../shared/worktree/ownership'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

const { toDetectedWorktreeSpy } = vi.hoisted(() => ({ toDetectedWorktreeSpy: vi.fn() }))

vi.mock('../../../../shared/worktree/ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnershipModule>()
  return {
    ...actual,
    toDetectedWorktree: (args: Parameters<typeof actual.toDetectedWorktree>[0]) => {
      toDetectedWorktreeSpy(args)
      return actual.toDetectedWorktree(args)
    }
  }
})

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCryptoModule>()),
  randomUUID: () => 'fixed-instance-id'
}))

const { buildDetectedGitWorktrees } = await import('./ssh-worktree-fallback')
const { getProjectHostSetupWorktreeMeta } =
  await import('../../../../shared/project-host-setup-lookup')

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

const ownershipMeta = getProjectHostSetupWorktreeMeta([], repo)

function gitWorktree(path: string): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false
  }
}

/** Settled metadata makes discovery backfill preserve object identity. */
function settledMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    ...ownershipMeta,
    instanceId: 'instance-settled',
    orcaCreatedAt: 1,
    lastActivityAt: 5,
    ...overrides
  } as WorktreeMeta
}

function createStore(meta: Record<string, WorktreeMeta>, repos: Repo[] = [repo]) {
  const rows = { ...meta }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store mock; the code under test reads only the members it defines.
  return {
    getRepos: () => repos,
    getSettings: () => ({ workspaceDir: '/workspace', nestWorkspaces: true }),
    getProjectHostSetups: () => [],
    getAllWorktreeLineage: () => ({}),
    getAllWorktreeMeta: () => rows,
    getWorktreeMeta: (id: string) => rows[id],
    getWorktreeMetaForHost: (id: string, hostId: string) =>
      rows[id]?.hostId === hostId ? rows[id] : undefined,
    getAllWorktreeMetaForHost: () => rows,
    setWorktreeMeta: ({ id, hostId }: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => {
      rows[id] = { ...rows[id], ...patch, hostId } as WorktreeMeta
      return rows[id]
    }
  } as unknown as Store
}

describe('buildDetectedGitWorktrees classification passes', () => {
  beforeEach(() => {
    toDetectedWorktreeSpy.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('classifies each visible worktree once per catalog pass, not twice', () => {
    const paths = ['/workspace/one', '/workspace/two', '/workspace/three']
    const meta = Object.fromEntries(
      paths.map((path) => [`${repo.id}::${path}`, settledMeta({ displayName: path })])
    )
    const store = createStore(meta)

    const detected = buildDetectedGitWorktrees(store, repo, paths.map(gitWorktree), meta)

    expect(detected).toHaveLength(3)
    expect(detected.every((row) => row.visible)).toBe(true)
    expect(toDetectedWorktreeSpy).toHaveBeenCalledTimes(paths.length)
  })

  it('reads the locator-keyed metadata row only when no host snapshot is available', () => {
    const worktreeId = `${repo.id}::/workspace/one`
    const meta = { [worktreeId]: settledMeta() }
    const store = createStore(meta)
    const legacyReads = vi.spyOn(store, 'getWorktreeMeta')

    buildDetectedGitWorktrees(store, repo, [gitWorktree('/workspace/one')], meta)
    expect(legacyReads).not.toHaveBeenCalled()

    // Older partial stores lack snapshots and still require locator-keyed lookup.
    const partialStore = createStore(meta) as Partial<Store>
    delete partialStore.getAllWorktreeMeta
    delete partialStore.getAllWorktreeMetaForHost
    delete partialStore.getWorktreeMetaForHost
    const partialLegacyReads = vi.spyOn(partialStore as Store, 'getWorktreeMeta')

    const rows = buildDetectedGitWorktrees(
      partialStore as Store,
      repo,
      [gitWorktree('/workspace/one')],
      undefined
    )
    expect(partialLegacyReads).toHaveBeenCalledWith(worktreeId)
    expect(rows[0]).toMatchObject({ id: worktreeId, lastActivityAt: 5 })
  })
})
