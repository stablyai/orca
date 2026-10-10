/**
 * Guards the single-classification contract of `buildDetectedGitWorktrees`: every visible worktree
 * used to be run through `mergeWorktree` + `toDetectedWorktree` twice per catalog pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type * as NodeCryptoModule from 'node:crypto'
import type * as OwnershipModule from '../../../../shared/worktree/ownership'

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
const { mergeWorktree } = await import('../../worktree-logic')
const { resolveWorktreeMetaWithDiscoveryBackfill } = await import('./worktree-discovery-metadata')
const ownership = await import('../../../../shared/worktree/ownership')
const { projectResolvedWorktreeLineage } =
  await import('../../../../shared/resolved-worktree-lineage')
const { createWorktreeVisibilitySourceMatcher, resolveCustomWorktreeVisibilitySources } =
  await import('../../../../shared/worktree/visibility-sources')
const { resolveConfiguredWorktreeBasePaths } =
  await import('../../../../shared/worktree/configured-worktree-base-path')
const { dedupeWorktreesByPath } = await import('../../worktree-path-comparison')
const { readWorktreeMetaForHost } =
  await import('../../../persistence/host-qualified-worktree-meta')
const { getRepoOwnedWorktreeMeta } = await import('../../../worktree-metadata-ownership')
const { getRepoExecutionHostId } = await import('../../../../shared/execution-host')

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

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

/** Fully settled metadata: discovery backfill has nothing to write, so it hands the same object back. */
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
    setWorktreeMeta: (id: string, patch: Partial<WorktreeMeta>) => {
      rows[id] = { ...rows[id], ...patch } as WorktreeMeta
      return rows[id]
    },
    setWorktreeMetaForHost: (id: string, hostId: string, patch: Partial<WorktreeMeta>) => {
      rows[id] = { ...rows[id], ...patch, hostId } as WorktreeMeta
      return rows[id]
    }
  } as unknown as Store
}

/** The pre-change implementation, verbatim, as the equivalence oracle. */
function buildDetectedGitWorktreesTwoPass(
  store: Store,
  target: Repo,
  gitWorktrees: GitWorktreeInfo[],
  allMetaOverride?: Record<string, WorktreeMeta>
) {
  const settings = store.getSettings()
  const knownOrcaLayouts = ownership.buildKnownOrcaWorkspaceLayouts(settings, target)
  const isLegacyRepoForVisibility = ownership.isLegacyRepoForExternalWorktreeVisibility(target)
  const liveWorktrees = dedupeWorktreesByPath(gitWorktrees.filter((info) => !info.prunable))
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [target.path, ...liveWorktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(target, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(target)
  )
  const allMeta = allMetaOverride ?? store.getAllWorktreeMeta?.()
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === target.id).length
  const detectedRows = liveWorktrees.map((info) => {
    const worktreeId = `${target.id}::${info.path}`
    const legacyMeta = store.getWorktreeMeta?.(worktreeId)
    const metaById = allMeta ?? (legacyMeta ? { [worktreeId]: legacyMeta } : {})
    let meta =
      readWorktreeMetaForHost(store, worktreeId, getRepoExecutionHostId(target)) ??
      getRepoOwnedWorktreeMeta(target, worktreeId, metaById, repoOwnerCount)
    const worktree = mergeWorktree(target.id, info, meta, target.displayName)
    const detected = ownership.toDetectedWorktree({
      repo: target,
      worktree,
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      worktreeVisibilitySourceMatcher
    })
    if (!detected.visible) {
      return detected
    }
    meta = resolveWorktreeMetaWithDiscoveryBackfill(
      store,
      target,
      worktreeId,
      allMeta,
      repoOwnerCount
    )
    return ownership.toDetectedWorktree({
      repo: target,
      worktree: mergeWorktree(target.id, info, meta, target.displayName),
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      worktreeVisibilitySourceMatcher
    })
  })
  return projectResolvedWorktreeLineage(detectedRows, store.getAllWorktreeLineage?.() ?? {})
}

describe('buildDetectedGitWorktrees classification passes', () => {
  beforeEach(() => {
    toDetectedWorktreeSpy.mockClear()
    // Discovery backfill stamps lastActivityAt from the clock; freeze it so equivalence is deterministic.
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

    // Partial stores (compatibility shapes) expose no snapshot, so the locator-keyed lookup must still run.
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

  it.each([
    ['settled metadata', () => settledMeta()],
    ['metadata needing discovery backfill', () => ({ orcaCreatedAt: 1 }) as WorktreeMeta],
    ['no metadata at all', () => undefined]
  ])('emits a catalog deep-equal to the two-pass build for %s', (_label, makeMeta) => {
    const worktreeId = `${repo.id}::/workspace/one`
    const seed = makeMeta()
    const build = (fn: typeof buildDetectedGitWorktrees) =>
      fn(
        createStore(seed ? { [worktreeId]: seed } : {}),
        repo,
        [gitWorktree('/workspace/one'), gitWorktree('/workspace/hidden-external')],
        seed ? { [worktreeId]: seed } : {}
      )

    expect(build(buildDetectedGitWorktrees)).toEqual(build(buildDetectedGitWorktreesTwoPass))
  })

  it('emits a catalog deep-equal to the two-pass build for a folder-style listing with no host snapshot', () => {
    const worktreeId = `${repo.id}::/workspace/one`
    const seed = settledMeta()
    const build = (fn: typeof buildDetectedGitWorktrees) =>
      fn(createStore({ [worktreeId]: seed }), repo, [gitWorktree('/workspace/one')], undefined)

    expect(build(buildDetectedGitWorktrees)).toEqual(build(buildDetectedGitWorktreesTwoPass))
  })
})
