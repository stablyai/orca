import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { parseWorktreeId } from '../paths/worktree-logic'
import { mergeWorktree } from '../metadata/worktree-metadata-merge'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitWorktreeInfo, DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { readWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'
import {
  buildKnownOrcaWorkspaceLayouts,
  toDetectedWorktree
} from '../../../../shared/worktree/visibility/ownership'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../../shared/worktree/visibility/external-worktree-visibility'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { collapsePathEqualWorktreeRows } from '../../../workspaces/catalog/path-equal-worktree-rows'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/paths/configured-worktree-base-path'
import { projectWorktreeLineageWithHostPeers } from '../../../workspaces/catalog/worktree-lineage-host-peers'
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

function addSshWorktreeMetaEntry(
  index: SshWorktreeMetaIndex,
  worktreeId: string,
  meta: WorktreeMeta
): void {
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
    return
  }
  let candidates = index.get(parsed.repoId)
  if (!candidates) {
    candidates = []
    index.set(parsed.repoId, candidates)
  }
  candidates.push({ id: worktreeId, path: parsed.worktreePath, meta })
}

export function createSshWorktreeMetaIndex(
  entries: [string, WorktreeMeta][]
): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (let i = 0; i < entries.length; i += 1) {
    addSshWorktreeMetaEntry(index, entries[i][0], entries[i][1])
  }
  return index
}

function hasOwnKeys(record: Readonly<Record<string, unknown>>): boolean {
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      return true
    }
  }
  return false
}

function countRepoOwners(repos: readonly Repo[], repoId: string): number {
  let count = 0
  for (const candidate of repos) {
    if (candidate.id === repoId) {
      count += 1
    }
  }
  return count
}

// Scope ID parsing to one repo; enumerating the store snapshot still costs a full pass.
export function createSshWorktreeMetaIndexForRepo(
  allMeta: Record<string, WorktreeMeta>,
  repoId: string
): SshWorktreeMetaIndex {
  const index: SshWorktreeMetaIndex = new Map()
  for (const worktreeId in allMeta) {
    if (Object.hasOwn(allMeta, worktreeId) && getRepoIdFromWorktreeId(worktreeId) === repoId) {
      addSshWorktreeMetaEntry(index, worktreeId, allMeta[worktreeId])
    }
  }
  return index
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
  const repoOwnerCount = countRepoOwners(store.getRepos(), repo.id)
  for (const candidate of metaIndex.get(repo.id) ?? []) {
    // An archived row has no checkout to show while its host is unreachable.
    if (
      (candidate.meta.hostId && candidate.meta.hostId !== expectedHostId) ||
      (!candidate.meta.hostId && repoOwnerCount > 1) ||
      candidate.meta.archivedCheckout
    ) {
      continue
    }
    const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, candidate.meta)
    const hasUpdates = hasOwnKeys(ownershipUpdates)
    const meta = hasUpdates ? { ...candidate.meta, ...ownershipUpdates } : candidate.meta
    if (hasUpdates) {
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
  const allMeta = allMetaOverride ?? store.getAllWorktreeMeta?.()
  const repoOwnerCount = countRepoOwners(store.getRepos(), repo.id)
  const readOwnedMeta = (worktreeId: string): WorktreeMeta | undefined => {
    const direct = readWorktreeMetaForRepo(store, worktreeId, repo)
    if (direct !== undefined) {
      return direct
    }
    // Locator-keyed metadata is only a compatibility fallback when no host snapshot exists.
    const legacyMeta = allMeta === undefined ? store.getWorktreeMeta?.(worktreeId) : undefined
    const metaById = allMeta ?? (legacyMeta ? { [worktreeId]: legacyMeta } : {})
    return getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
  }
  // Keep failed removals retryable; other prunable registrations stay hidden (#8389).
  const liveWorktrees = collapsePathEqualWorktreeRows(
    repo,
    preserveFolderUpgradeWorktreePath(repo, gitWorktrees).filter(
      (gitWorktree) => !gitWorktree.prunable || !!gitWorktree.removalError
    ),
    (worktreeId) => readOwnedMeta(worktreeId) !== undefined
  )
  const visibilityPaths: string[] = [repo.path]
  for (let i = 0; i < liveWorktrees.length; i += 1) {
    visibilityPaths.push(liveWorktrees[i].path)
  }
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    visibilityPaths,
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const detected = liveWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    const meta = readOwnedMeta(worktreeId)
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
