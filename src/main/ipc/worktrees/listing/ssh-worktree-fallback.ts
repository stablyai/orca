import { preserveFolderUpgradeWorktreePath } from '../../../folder-upgrade-worktree-path'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { parseWorktreeId } from '../../worktree-logic'
import { mergeWorktree } from '../../worktree-metadata-merge'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo, DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { readWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoOwnedWorktreeMeta } from '../../../worktree-metadata-ownership'
import {
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../../../shared/worktree/ownership'
import { areWorktreePathsEqual, dedupeWorktreesByPath } from '../../../git/worktree-path-comparison'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'
import { projectWorktreeLineageWithHostPeers } from '../../../worktree-lineage-host-peers'
import { loggedMalformedWorktreeMetaKeys, warnOnce } from './worktree-listing-diagnostics'
import {
  getProjectHostSetupMetaUpdates,
  resolveWorktreeMetaWithDiscoveryBackfill
} from './worktree-discovery-metadata'

export type SshWorktreeMetaCandidate = {
  id: string
  path: string
  meta: WorktreeMeta
}

export type SshWorktreeMetaIndex = Map<string, SshWorktreeMetaCandidate[]>

export function createSshWorktreeMetaIndex(
  entries: [string, WorktreeMeta][]
): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (const [worktreeId, meta] of entries) {
    let parsed: { repoId: string; worktreePath: string }
    try {
      parsed = parseWorktreeId(worktreeId)
    } catch (err) {
      warnOnce(
        loggedMalformedWorktreeMetaKeys,
        worktreeId,
        `[worktrees] ignoring malformed persisted worktree metadata key "${worktreeId}"`,
        err
      )
      continue
    }

    const candidates = index.get(parsed.repoId) ?? []
    candidates.push({ id: worktreeId, path: parsed.worktreePath, meta })
    index.set(parsed.repoId, candidates)
  }
  return index
}

// Scope ID parsing to one repo; enumerating the store snapshot still costs a full pass.
export function createSshWorktreeMetaIndexForRepo(
  allMeta: Record<string, WorktreeMeta>,
  repoId: string
): SshWorktreeMetaIndex {
  return createSshWorktreeMetaIndex(
    Object.entries(allMeta).filter(([worktreeId]) => getRepoIdFromWorktreeId(worktreeId) === repoId)
  )
}

export function synthesizeSshGitWorktree(
  repo: Repo,
  path: string,
  meta: WorktreeMeta
): GitWorktreeInfo {
  return {
    path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: areWorktreePathsEqual(path, repo.path),
    ...(meta.sparseDirectories !== undefined ||
    meta.sparseBaseRef !== undefined ||
    meta.sparsePresetId !== undefined
      ? { isSparse: true }
      : {})
  }
}

export function listDisconnectedSshWorktrees(
  store: Store,
  repo: Repo,
  metaIndex: SshWorktreeMetaIndex
): Worktree[] {
  const byWorktreeId = new Map<string, Worktree>()
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  for (const candidate of metaIndex.get(repo.id) ?? []) {
    if (
      (candidate.meta.hostId && candidate.meta.hostId !== expectedHostId) ||
      (!candidate.meta.hostId && repoOwners.length > 1)
    ) {
      continue
    }
    const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, candidate.meta)
    const meta =
      Object.keys(ownershipUpdates).length > 0
        ? { ...candidate.meta, ...ownershipUpdates }
        : candidate.meta
    if (Object.keys(ownershipUpdates).length > 0) {
      store.setWorktreeMeta(
        hostWorktreeTarget({ id: candidate.id, hostId: expectedHostId }),
        ownershipUpdates
      )
    }
    // Remote Windows paths need separator-independent basenames; host basename or repo displayName mislabels rows.
    const worktree = mergeWorktree(
      repo.id,
      synthesizeSshGitWorktree(repo, candidate.path, meta),
      meta,
      getWorktreePathBasenameFromId(candidate.id) ?? undefined
    )
    byWorktreeId.delete(worktree.id)
    byWorktreeId.set(worktree.id, worktree)
  }
  return [...byWorktreeId.values()]
}

export function buildDetectedGitWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  allMetaOverride?: Record<string, WorktreeMeta>
): DetectedWorktree[] {
  const settings = store.getSettings()
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
  const isLegacyRepoForVisibility = isLegacyRepoForExternalWorktreeVisibility(repo)
  // Keep failed removals retryable; other prunable registrations stay hidden (#8389).
  const liveWorktrees = dedupeWorktreesByPath(
    preserveFolderUpgradeWorktreePath(repo, gitWorktrees).filter(
      (gitWorktree) => !gitWorktree.prunable || !!gitWorktree.removalError
    )
  )
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...liveWorktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const allMeta = allMetaOverride ?? store.getAllWorktreeMeta?.()
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  const detected = liveWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    // Locator-keyed metadata is only a compatibility fallback when no host snapshot exists.
    const legacyMeta = allMeta === undefined ? store.getWorktreeMeta?.(worktreeId) : undefined
    const metaById = allMeta ?? (legacyMeta ? { [worktreeId]: legacyMeta } : {})
    const meta =
      readWorktreeMetaForRepo(store, worktreeId, repo) ??
      getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
    const worktree = mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
    const detected = toDetectedWorktree({
      repo,
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

    const backfilledMeta = resolveWorktreeMetaWithDiscoveryBackfill(
      store,
      repo,
      worktreeId,
      allMeta,
      repoOwnerCount
    )
    // Unchanged backfill preserves object identity, letting pure builders reuse the classified row.
    if (backfilledMeta === meta) {
      return detected
    }
    return toDetectedWorktree({
      repo,
      worktree: mergeWorktree(repo.id, gitWorktree, backfilledMeta, repo.displayName),
      meta: backfilledMeta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      worktreeVisibilitySourceMatcher
    })
  })
  return projectWorktreeLineageWithHostPeers(store, repo, detected)
}
