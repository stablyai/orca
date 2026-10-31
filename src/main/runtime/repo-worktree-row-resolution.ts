import {
  listStoredWorktreeRowsForRepo,
  storedWorktreePresentation
} from './stored-repo-worktree-rows'
export { listStoredWorktreeRowsForRepo } from './stored-repo-worktree-rows'
import { scanUntilNotOvertaken } from '../ipc/worktrees/listing/overtaken-scan-rerun'
import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../local-worktree-scan-generation'
import { preserveFolderUpgradeWorktreePath } from '../folder-upgrade-worktree-path'
import {
  composeWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey
} from '../../shared/worktree/id'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../../shared/resolved-worktree-lineage'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeStore } from './runtime-store-contract'

import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { resolveLocalProjectRuntimesForRepos } from '../project-runtime-git-options'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

type RepoWorktreeRowStore = Pick<
  RuntimeStore,
  | 'onStateWritten'
  | 'onWorkspaceSessionWritten'
  | 'getWorkspaceSession'
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
    projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
    signal?: AbortSignal
  ) => Promise<RuntimeWorktreeScanResult>
  /** Folder workspaces are stamped from runtime-owned identity helpers, so the caller supplies them. */
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
}

/** One git repo's checkouts as its scan saw them; carries no metadata, which is joined at read. */
export type RepoWorktreeRowsScan = RuntimeWorktreeScanResult

/** The scan half of `resolveRepoWorktreeRows`: slow, and the only part that awaits. */
export async function scanRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'scanRepo'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRowsScan> {
  const { store } = deps
  // The deadline releases this waiter; failed evidence projects current stored rows.
  const controller = new AbortController()
  const pending = scanUntilNotOvertaken(
    repo.id,
    async () => {
      const generation = getLocalWorktreeScanGeneration(repo.id)
      const scan: RuntimeWorktreeScanResult = await deps
        .scanRepo(repo, projectRuntimeByRepoId, controller.signal)
        .catch(() => ({ ok: false, worktrees: [] }))
      const isCurrent = () =>
        isLocalWorktreeScanGenerationCurrent(repo.id, generation) && scan.isCurrent?.() !== false
      return { ...scan, isCurrent, superseded: !isCurrent() }
    },
    () => !controller.signal.aborted
  )
  const observed = await withTimeout(
    pending.catch(() => null),
    RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
    null
  )
  if (!observed) {
    controller.abort()
  }
  const scan = observed && !observed.superseded ? observed : null
  if (!scan?.ok) {
    return { ok: false, worktrees: listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount) }
  }
  const gitWorktrees = preserveFolderUpgradeWorktreePath(repo, scan.worktrees)
  if (scan.isCurrent?.() !== false) {
    pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
  }
  return { ...scan, worktrees: gitWorktrees }
}

/** Stored representation is useful, but never a branch/absence verdict or stamp permission. */
export function currentRepoWorktreeScan(
  store: RepoWorktreeRowStore,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRowsScan | null {
  return scan && (!scan.ok || scan.isCurrent?.() === false)
    ? { ok: false, worktrees: listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount) }
    : scan
}

/** The join half: a repo's rows from a scan and the metadata as it is now. Synchronous. */
export function projectRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  return projectCurrentRepoWorktreeRows(
    deps,
    repo,
    currentRepoWorktreeScan(deps.store, repo, scan, repoOwnerCount),
    metaById,
    repoOwnerCount
  )
}

function projectCurrentRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount: number
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
  return (scan?.worktrees ?? []).map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    const meta =
      readWorktreeMetaForHost(store, worktreeId, expectedHostId) ??
      getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
    const merged = {
      ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      hostId: meta?.hostId ?? expectedHostId
    }
    return {
      ...merged,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: gitWorktree.path,
        head: gitWorktree.head,
        branch: gitWorktree.branch,
        isBare: gitWorktree.isBare,
        isMainWorktree: gitWorktree.isMainWorktree
      },
      ...(!scan?.ok ? storedWorktreePresentation(meta, merged) : {}),
      comment: merged.comment
    }
  })
}

/** Resolution owns durable identity stamping; memory projection never calls this wrapper. */
export function joinRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  scan = currentRepoWorktreeScan(deps.store, repo, scan, repoOwnerCount)
  let projectedMeta: Record<string, WorktreeMeta> | undefined
  if (!isFolderRepo(repo) && scan?.ok) {
    const hostId = getRepoExecutionHostId(repo)
    for (const git of scan?.worktrees ?? []) {
      const id = composeWorktreeId(repo.id, git.path)
      const owned =
        readWorktreeMetaForHost(deps.store, id, hostId) ??
        getRepoOwnedWorktreeMeta(repo, id, metaById, repoOwnerCount)
      if (!owned?.instanceId && (owned || (!metaById[id] && repoOwnerCount === 1))) {
        projectedMeta ??= { ...metaById }
        projectedMeta[id] = deps.store.setWorktreeMeta(hostWorktreeTarget({ id, hostId }), {})
      }
    }
  }
  return projectCurrentRepoWorktreeRows(deps, repo, scan, projectedMeta ?? metaById, repoOwnerCount)
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
  const owners = store
    .getRepos()
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
  const ownerScan = isFolderRepo(repo)
    ? null
    : await scanRepoWorktreeRows(deps, repo, resolveLocalProjectRuntimesForRepos(store, [repo]))
  let ownerRows = projectRepoWorktreeRows(deps, repo, ownerScan, store.getAllWorktreeMeta() ?? {})
  // Accept one normalized equivalent id; multiple path matches remain ambiguous (#16243).
  const comparisonKey = worktreeIdentityKey(worktreeId)
  const exact = ownerRows.find((worktree) => worktree.id === worktreeId)
  const equivalent = ownerRows.filter(
    (worktree) => worktreeIdentityKey(worktree.id) === comparisonKey
  )
  let target = exact ?? (equivalent.length === 1 ? equivalent[0] : null)
  if (!target) {
    return null
  }
  let lineageById = store.getAllWorktreeLineage?.() ?? {}
  const relatedIds = getConnectedWorktreeLineageIds([target.id], lineageById)
  const relatedRepoIds = new Set(
    [...relatedIds]
      .map((id) => splitWorktreeIdForFilesystem(id)?.repoId)
      .filter((id) => id !== undefined)
  )
  relatedRepoIds.delete(repo.id)
  const hostId = getRepoExecutionHostId(repo)
  const relatedRepos = store
    .getRepos()
    .filter(
      (candidate) =>
        relatedRepoIds.has(candidate.id) && getRepoExecutionHostId(candidate) === hostId
    )
  if (new Set(relatedRepos.map((candidate) => candidate.id)).size !== relatedRepos.length) {
    return null
  }
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, relatedRepos)
  const relatedScans = await Promise.all(
    relatedRepos.map(async (relatedRepo) => ({
      repo: relatedRepo,
      scan: isFolderRepo(relatedRepo)
        ? null
        : await scanRepoWorktreeRows(deps, relatedRepo, projectRuntimeByRepoId)
    }))
  )
  const currentMeta = store.getAllWorktreeMeta() ?? {}
  if (!isFolderRepo(repo) || relatedRepos.length > 0) {
    ownerRows = joinRepoWorktreeRows(deps, repo, ownerScan, currentMeta)
  }
  target = ownerRows.find((row) => row.id === target?.id) ?? null
  if (!target) {
    return null
  }
  const otherRows = relatedScans.map(({ repo: relatedRepo, scan }) =>
    joinRepoWorktreeRows(deps, relatedRepo, scan, currentMeta)
  )

  lineageById = store.getAllWorktreeLineage?.() ?? {}
  const projected = projectResolvedWorktreeLineage([...ownerRows, ...otherRows.flat()], lineageById)
  return projected[ownerRows.indexOf(target)] ?? null
}
