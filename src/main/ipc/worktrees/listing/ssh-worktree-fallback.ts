import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { parseWorktreeId, areWorktreePathsEqual, mergeWorktree } from '../../worktree-logic'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo, DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../../../shared/worktree/ownership'
import { dedupeWorktreesByPath } from '../../worktree-path-comparison'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
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

// Why: scopes parseWorktreeId to one repo's keys. The entry list itself is still materialized for the whole
// store, so this is cheaper per call than the unfiltered index, not free.
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
      store.setWorktreeMeta(candidate.id, ownershipUpdates)
    }
    // Why: synthesized rows carry no branch, so the title would fall through to the DESKTOP's basename()
    // applied to a REMOTE path — a Windows remote then renders its whole C:\... path as the name. Rows must
    // stay per-directory (repo.displayName would title every row identically), so use the separator-agnostic
    // basename instead.
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
  gitWorktrees: GitWorktreeInfo[]
): DetectedWorktree[] {
  const settings = store.getSettings()
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(settings, repo)
  const isLegacyRepoForVisibility = isLegacyRepoForExternalWorktreeVisibility(repo)
  // Why: a prunable registration has no working directory (issue #8389); only this listing omits it — cleanup flows list separately.
  const liveWorktrees = dedupeWorktreesByPath(
    gitWorktrees.filter((gitWorktree) => !gitWorktree.prunable)
  )
  const worktreeVisibilitySourceMatcher = createWorktreeVisibilitySourceMatcher(
    [repo.path, ...liveWorktrees.map((worktree) => worktree.path)],
    resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const detected = liveWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    let meta = store.getWorktreeMeta(worktreeId)
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

    meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, worktreeId)
    return toDetectedWorktree({
      repo,
      worktree: mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      meta,
      settings,
      knownOrcaLayouts,
      isLegacyRepoForVisibility,
      worktreeVisibilitySourceMatcher
    })
  })
  return projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
}

export function stampAndMergeVisibleDetectedWorktree(
  store: Store,
  repo: Repo,
  detected: DetectedWorktree
) {
  const meta = resolveWorktreeMetaWithDiscoveryBackfill(store, repo, detected.id)
  return mergeWorktree(repo.id, detected, meta, repo.displayName)
}
