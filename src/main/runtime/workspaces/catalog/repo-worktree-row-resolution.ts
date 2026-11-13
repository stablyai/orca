import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
import {
  composeWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey
} from '../../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../../../../shared/resolved-worktree-lineage'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'

import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import { getLocalWorktreeScanGeneration } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import {
  listStoredWorktreeRowsForRepo,
  type RuntimeWorktreeScanResult,
  type RuntimeWorktreeScanAttempt
} from './repo-worktree-resolution-scan'
import { isAdoptableGitWorktree } from '../../../workspaces/catalog/git-worktree-observations'
import {
  currentRuntimeWorktreeScanRepo,
  type WitnessedRuntimeWorktreeScan
} from './runtime-witnessed-worktree-scan'
import type { WorktreeRemovalWitnessScan } from '../../../workspaces/removal/worktree-removal-listing'
import { projectRepoWorktreeRows } from './repo-worktree-row-projection'
import { pendingWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-table'

export type RepoWorktreeRowStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getRepo'
  | 'getProjects'
  | 'getProjectHostSetups'
  | 'getSettings'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getWorktreeMeta'
  | 'getWorktreeMetaForHost'
  | 'setWorktreeMeta'
  | 'getAllWorktreeLineage'
  | 'getAllWorkspaceLineage'
  | 'removeWorktreeLineage'
>

/** Bound each repo independently for mobile startup; fingerprint probes derive their smaller budget from this shared constant. */
export const RESOLVED_WORKTREE_REPO_TIMEOUT_MS = 5000

/** Scans start without lineage; keep its type nullable so later projection can fill it. */
export type RepoWorktreeRow = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: Pick<GitWorktreeInfo, 'path' | 'head' | 'branch' | 'isBare' | 'isMainWorktree' | 'prunable'>
}

export type RepoWorktreeRowDeps = {
  store: RepoWorktreeRowStore
  /** The cache-aware per-repo scan. Injected so this module never owns scan-cache state. */
  scanRepo: (
    repo: Repo,
    projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ) => Promise<WitnessedRuntimeWorktreeScan>
  getCachedSuccessfulScan?: (repo: Repo) => RuntimeWorktreeScanResult | undefined
  /** Once per new observation, with its scan-start generation; absent keeps per-read pruning. */
  claimLineagePrune?: (scan: RuntimeWorktreeScanResult) => { scanGeneration: number } | null
  /** Folder workspaces are stamped from runtime-owned identity helpers, so the caller supplies them. */
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
}

export { listStoredWorktreeRowsForRepo } from './repo-worktree-resolution-scan'
export { projectRepoWorktreeRows } from './repo-worktree-row-projection'

/** One git repo's checkouts as its scan saw them; carries no metadata, which is joined at read. */
export type RepoWorktreeRowsScan = RuntimeWorktreeScanAttempt &
  Partial<Pick<WitnessedRuntimeWorktreeScan, 'scanGeneration' | 'isCurrent'>> &
  WorktreeRemovalWitnessScan

/** The scan half of `resolveRepoWorktreeRows`: slow, and the only part that awaits. */
export async function scanRepoWorktreeRows(
  deps: Omit<RepoWorktreeRowDeps, 'listFolderWorkspaces'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRowsScan> {
  repo = { ...repo }
  const { store } = deps
  const removals =
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? pendingWorktreeRemovals.snapshotForRepo(repo.id)
      : undefined
  const scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  // Absorb rejection before withTimeout: rejection preserves shipped empty results, but timeout restores last-known rows.
  const scan: RepoWorktreeRowsScan = (await withTimeout<RepoWorktreeRowsScan | null>(
    deps
      .scanRepo(repo, projectRuntimeByRepoId)
      .catch(() => ({ ok: false, worktrees: [] }) satisfies RuntimeWorktreeScanResult),
    RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
    null
  )) ?? {
    ok: false,
    worktrees:
      deps.getCachedSuccessfulScan?.(repo)?.worktrees ??
      listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount)
  }
  if (scan.superseded || (scan.isCurrent && !scan.isCurrent())) {
    const current = currentRuntimeWorktreeScanRepo(store, repo)
    return {
      ...scan,
      ok: false,
      superseded: true,
      worktrees: current ? listStoredWorktreeRowsForRepo(store, current) : []
    }
  }
  repo = currentRuntimeWorktreeScanRepo(store, repo) ?? repo
  const gitWorktrees = preserveFolderUpgradeWorktreePath(repo, scan.worktrees)
  // Cached reads must not re-prune against a generation captured after their rows were observed.
  const lineage =
    scan.ok && (deps.claimLineagePrune ? deps.claimLineagePrune(scan) : { scanGeneration })
  if (lineage) {
    pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees, lineage)
  }
  return { ...scan, worktrees: gitWorktrees, removals, projectedRemovals: removals }
}

/** Resolution owns durable identity stamping; memory projection never calls this wrapper. */
export function joinRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  if (scan?.superseded || (scan?.isCurrent && !scan.isCurrent())) {
    const current = currentRuntimeWorktreeScanRepo(deps.store, repo)
    return current
      ? projectRepoWorktreeRows(
          deps,
          current,
          { ok: false, worktrees: listStoredWorktreeRowsForRepo(deps.store, current) },
          deps.store.getAllWorktreeMeta() ?? {}
        )
      : []
  }
  if (scan?.isCurrent) {
    repo = currentRuntimeWorktreeScanRepo(deps.store, repo) ?? repo
  }
  let projectedMeta: Record<string, WorktreeMeta> | undefined
  if (!isFolderRepo(repo)) {
    const hostId = getRepoExecutionHostId(repo)
    for (const git of scan?.worktrees ?? []) {
      const id = composeWorktreeId(repo.id, git.path)
      const owned =
        readWorktreeMetaForHost(deps.store, id, hostId) ??
        getRepoOwnedWorktreeMeta(repo, id, metaById, repoOwnerCount)
      if (scan?.ok && !owned && !isAdoptableGitWorktree(git) && !git.removalError) {
        continue
      }
      if (!owned?.instanceId && (owned || (!metaById[id] && repoOwnerCount === 1))) {
        projectedMeta ??= { ...metaById }
        projectedMeta[id] = deps.store.setWorktreeMeta(hostWorktreeTarget({ id, hostId }), {})
      }
    }
  }
  return projectRepoWorktreeRows(deps, repo, scan, projectedMeta ?? metaById, repoOwnerCount)
}

/** One repo's worktree rows before lineage projection. Shared by the fleet scan and scoped lookups. */
export async function resolveRepoWorktreeRows(
  deps: RepoWorktreeRowDeps,
  repo: Repo,
  metaById: Record<string, WorktreeMeta>,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRow[]> {
  repo = { ...repo }
  const scan = isFolderRepo(repo)
    ? null
    : await scanRepoWorktreeRows(deps, repo, projectRuntimeByRepoId, repoOwnerCount)
  return joinRepoWorktreeRows(deps, repo, scan, metaById, repoOwnerCount)
}

/** Resolve one id through its host owner and lineage repos; ambiguous ownership returns null for fleet fallback. */
export async function resolveScopedWorktreeIdRow(
  deps: RepoWorktreeRowDeps,
  worktreeId: string,
  requiredHostId?: ExecutionHostId
): Promise<RepoWorktreeRow | null> {
  const { store } = deps
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return null
  }
  const repoOwners = createRepoRowExecutionHostLookup(store.getRepos())
  const owners = repoOwners
    .rowsFor(parsed.repoId)
    .filter(
      (repo) =>
        repo.id === parsed.repoId &&
        (requiredHostId === undefined || getRepoExecutionHostId(repo) === requiredHostId)
    )
  // Only fleet scans disambiguate multiple unqualified owners; scoped lookup must not guess.
  if (owners.length !== 1) {
    return null
  }
  const repo = owners[0]
  const ownerRows = await resolveRepoWorktreeRows(
    deps,
    repo,
    store.getAllWorktreeMeta() ?? {},
    resolveLocalProjectRuntimesForRepos(store, [repo]),
    repoOwners.rowsFor(repo.id).length
  )
  // Accept one normalized equivalent id; multiple path matches remain ambiguous (#16243).
  const comparisonKey = worktreeIdentityKey(worktreeId)
  const exact = ownerRows.find((worktree) => worktree.id === worktreeId)
  const equivalent = ownerRows.filter(
    (worktree) => worktreeIdentityKey(worktree.id) === comparisonKey
  )
  const target = exact ?? (equivalent.length === 1 ? equivalent[0] : null)
  if (!target) {
    return null
  }
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const relatedIds = getConnectedWorktreeLineageIds([target.id], lineageById)
  const relatedRepoIds = new Set(
    [...relatedIds]
      .map((id) => splitWorktreeIdForFilesystem(id)?.repoId)
      .filter((id) => id !== undefined)
  )
  relatedRepoIds.delete(repo.id)
  const hostId = getRepoExecutionHostId(repo)
  const registered = store.getRepos()
  const relatedOwners = createRepoRowExecutionHostLookup(registered)
  const relatedRepos = registered.filter(
    (candidate) => relatedRepoIds.has(candidate.id) && getRepoExecutionHostId(candidate) === hostId
  )
  if (new Set(relatedRepos.map((candidate) => candidate.id)).size !== relatedRepos.length) {
    return null
  }
  const metaById = store.getAllWorktreeMeta() ?? {}
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, relatedRepos)
  const otherRows = await Promise.all(
    relatedRepos.map((relatedRepo) =>
      resolveRepoWorktreeRows(
        deps,
        relatedRepo,
        metaById,
        projectRuntimeByRepoId,
        relatedOwners.rowsFor(relatedRepo.id).length
      )
    )
  )
  const projected = projectResolvedWorktreeLineage([...ownerRows, ...otherRows.flat()], lineageById)
  return projected[ownerRows.indexOf(target)] ?? null
}
