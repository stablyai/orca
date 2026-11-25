import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
import { composeWorktreeId, splitWorktreeId } from '../../../../shared/worktree/id'
// oxfmt-ignore
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { mergeWorktree } from '../../../ipc/worktrees/metadata/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import { getLocalWorktreeScanGeneration } from '../../../workspaces/catalog/local-worktree-scan-generation'
import {
  getRepoOwnedWorktreeMeta,
  isWorktreeMetaOwnedByRepo
} from '../../../workspaces/catalog/worktree-metadata-ownership'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import {
  projectCachedWorktreeRemovals,
  type WorktreeRemovalWitnessScan
} from '../../../workspaces/removal/worktree-removal-listing'
import { pendingWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-table'
import type { WorktreeRowProjectionMemo } from './worktree-row-projection-memo'

type RepoWorktreeRowStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getRepo'
  | 'getProjects'
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
  git: Pick<GitWorktreeInfo, 'path' | 'head' | 'branch' | 'isBare' | 'isMainWorktree'>
}

export type RepoWorktreeRowDeps = {
  store: RepoWorktreeRowStore
  /** The cache-aware per-repo scan. Injected so this module never owns scan-cache state. */
  scanRepo: (
    repo: Repo,
    projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ) => Promise<RuntimeWorktreeScanResult>
  getCachedSuccessfulScan?: (repo: Repo) => RuntimeWorktreeScanResult | undefined
  /** Once per new observation, with its scan-start generation; absent keeps per-read pruning. */
  claimLineagePrune?: (scan: RuntimeWorktreeScanResult) => { scanGeneration: number } | null
  /** Folder workspaces are stamped from runtime-owned identity helpers, so the caller supplies them. */
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
  /** Owned by the catalog so unchanged rows survive between joins. */
  rowMemo?: WorktreeRowProjectionMemo<RepoWorktreeRow>
}

export function worktreeRowMemoRepoKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}\u0000${repo.id}`
}

/** Publish last-known persisted rows on unreachable/stalled scans, matching disconnected SSH listing behavior. */
export function listStoredWorktreeRowsForRepo(
  store: RepoWorktreeRowStore,
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): GitWorktreeInfo[] {
  const expectedHostId = getRepoExecutionHostId(repo)
  const byWorktreeId = new Map<string, GitWorktreeInfo>()
  for (const [worktreeId, meta] of Object.entries(
    readAllWorktreeMetaForHost(store, expectedHostId)
  )) {
    const parsed = splitWorktreeId(worktreeId)
    // An archived row has no checkout, so it must not come back as a live worktree.
    if (!parsed || parsed.repoId !== repo.id || meta.archivedCheckout) {
      continue
    }
    // Same repo ids can belong to several hosts; degraded scans must not publish another owner's metadata.
    if (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1) {
      continue
    }
    byWorktreeId.set(worktreeId, {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: areWorktreePathsEqual(parsed.worktreePath, repo.path),
      ...(meta.sparseDirectories !== undefined ||
      meta.sparseBaseRef !== undefined ||
      meta.sparsePresetId !== undefined
        ? { isSparse: true }
        : {})
    })
  }
  return [...byWorktreeId.values()]
}

/** One git repo's checkouts as its scan saw them; carries no metadata, which is joined at read. */
export type RepoWorktreeRowsScan = {
  ok: boolean
  worktrees: GitWorktreeInfo[]
} & WorktreeRemovalWitnessScan

/** The scan half of `resolveRepoWorktreeRows`: slow, and the only part that awaits. */
export async function scanRepoWorktreeRows(
  deps: Omit<RepoWorktreeRowDeps, 'listFolderWorkspaces'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRowsScan> {
  const { store } = deps
  const removals =
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? pendingWorktreeRemovals.snapshotForRepo(repo.id)
      : undefined
  const scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  // Absorb rejection before withTimeout: rejection preserves shipped empty results, but timeout restores last-known rows.
  const scan: RuntimeWorktreeScanResult = (await withTimeout<RuntimeWorktreeScanResult | null>(
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
  const gitWorktrees = preserveFolderUpgradeWorktreePath(repo, scan.worktrees)
  // Cached reads must not re-prune against a generation captured after their rows were observed.
  const lineage =
    scan.ok && (deps.claimLineagePrune ? deps.claimLineagePrune(scan) : { scanGeneration })
  if (lineage) {
    pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees, lineage)
  }
  return { ok: scan.ok, worktrees: gitWorktrees, removals, projectedRemovals: removals }
}

/** The join half: a repo's rows from a scan and the metadata as it is now. Synchronous. */
export function projectRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces' | 'rowMemo'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length,
  stamped?: ReadonlyMap<string, WorktreeMeta>,
  // What the stamp loop already read for each unstamped row, so it isn't read twice.
  ownedMeta?: ReadonlyMap<string, WorktreeMeta | undefined>
): RepoWorktreeRow[] {
  const { store } = deps
  if (isFolderRepo(repo)) {
    return deps.listFolderWorkspaces(repo, repoOwnerCount).map((worktree) => ({
      ...worktree,
      hostId: worktree.hostId ?? getRepoExecutionHostId(repo),
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      },
      displayName: worktree.displayName,
      comment: worktree.comment
    }))
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoKey = worktreeRowMemoRepoKey(repo)
  const rows = (scan?.worktrees ?? []).map((gitWorktree): RepoWorktreeRow => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    let meta: WorktreeMeta | undefined
    if (ownedMeta?.has(worktreeId)) {
      meta = ownedMeta.get(worktreeId)
    } else {
      const known = stamped?.get(worktreeId) ?? metaById[worktreeId]
      meta =
        readWorktreeMetaForHost(store, worktreeId, expectedHostId) ??
        (isWorktreeMetaOwnedByRepo(repo, known, repoOwnerCount) ? known : undefined)
    }
    const build = (): RepoWorktreeRow => ({
      ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      hostId: meta?.hostId ?? expectedHostId,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: gitWorktree.path,
        head: gitWorktree.head,
        branch: gitWorktree.branch,
        isBare: gitWorktree.isBare,
        isMainWorktree: gitWorktree.isMainWorktree
      }
    })
    return deps.rowMemo
      ? deps.rowMemo.rowFor(
          repoKey,
          worktreeId,
          {
            repoId: repo.id,
            repoDisplayName: repo.displayName,
            expectedHostId,
            git: gitWorktree,
            meta
          },
          build
        )
      : build()
  })
  if (expectedHostId !== LOCAL_EXECUTION_HOST_ID || !scan) {
    return rows
  }
  return projectCachedWorktreeRemovals(repo.id, scan, rows, (row) => row.id)
}

/** Resolution owns durable identity stamping; memory projection never calls this wrapper. */
export function joinRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces' | 'rowMemo'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  const ownedMeta = new Map<string, WorktreeMeta | undefined>()
  const stamped = stampRepoWorktreeRows(deps, repo, scan, metaById, repoOwnerCount, ownedMeta)
  const rows = projectRepoWorktreeRows(
    deps,
    repo,
    scan,
    metaById,
    repoOwnerCount,
    stamped,
    ownedMeta
  )
  if (deps.rowMemo && !isFolderRepo(repo)) {
    deps.rowMemo.keepOnly(
      worktreeRowMemoRepoKey(repo),
      new Set((scan?.worktrees ?? []).map((git) => composeWorktreeId(repo.id, git.path)))
    )
  }
  return rows
}

/** Read every scanned checkout's host metadata (which migrates it) and stamp missing identities.
 *  Returns only the rows stamped here; copying the whole metadata map would cost every repo.
 *  `ownedMeta` receives what was read for each row left unstamped. */
export function stampRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount: number,
  ownedMeta?: Map<string, WorktreeMeta | undefined>
): Map<string, WorktreeMeta> {
  const stamped = new Map<string, WorktreeMeta>()
  if (isFolderRepo(repo)) {
    return stamped
  }
  const hostId = getRepoExecutionHostId(repo)
  for (const git of scan?.worktrees ?? []) {
    const id = composeWorktreeId(repo.id, git.path)
    const owned =
      readWorktreeMetaForHost(deps.store, id, hostId) ??
      getRepoOwnedWorktreeMeta(repo, id, metaById, repoOwnerCount)
    if (!owned?.instanceId && (owned || (!metaById[id] && repoOwnerCount === 1))) {
      stamped.set(id, deps.store.setWorktreeMeta(hostWorktreeTarget({ id, hostId }), {}))
    } else {
      ownedMeta?.set(id, owned)
    }
  }
  return stamped
}

/** One repo's worktree rows before lineage projection. Shared by the fleet scan and scoped lookups. */
export async function resolveRepoWorktreeRows(
  deps: RepoWorktreeRowDeps,
  repo: Repo,
  metaById: Record<string, WorktreeMeta>,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRow[]> {
  const scan = isFolderRepo(repo)
    ? null
    : await scanRepoWorktreeRows(deps, repo, projectRuntimeByRepoId, repoOwnerCount)
  return joinRepoWorktreeRows(deps, repo, scan, metaById, repoOwnerCount)
}
