import {
  composeWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey
} from '../../../../shared/worktree/id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../../../../shared/resolved-worktree-lineage'
import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'

import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import { getLocalWorktreeScanGeneration } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import type {
  RuntimeWorktreeScanResult,
  RepoWorktreeRowsScan
} from './repo-worktree-resolution-scan'
export type { RepoWorktreeRowsScan } from './repo-worktree-resolution-scan'
import { projectCachedWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-listing'
import { readRepoWorktreeRowsScan } from './repo-worktree-rows-scan'
export {
  readRepoWorktreeRowsScan,
  listStoredWorktreeRowsForRepo,
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS
} from './repo-worktree-rows-scan'

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
}

/** Catalog maintenance belongs to launch/listing owners, not read-only inventory. */
export async function scanRepoWorktreeRows(
  deps: Omit<RepoWorktreeRowDeps, 'listFolderWorkspaces'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount?: number
): Promise<RepoWorktreeRowsScan> {
  const scanGeneration = getLocalWorktreeScanGeneration(repo.id)
  const scan = await readRepoWorktreeRowsScan(deps, repo, projectRuntimeByRepoId, repoOwnerCount)
  const lineage =
    scan.ok &&
    (deps.claimLineagePrune ? deps.claimLineagePrune(scan.observation ?? scan) : { scanGeneration })
  if (lineage) {
    pruneLineageForMissingRepoWorktrees(deps.store, repo, scan.worktrees, lineage)
  }
  return scan
}

/** The join half: a repo's rows from a scan and the metadata as it is now. Synchronous. */
export function projectRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
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
  const rows = (scan?.worktrees ?? []).map((gitWorktree) => {
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
      }
    }
  })
  if (expectedHostId !== LOCAL_EXECUTION_HOST_ID || !scan) {
    return rows
  }
  return projectCachedWorktreeRemovals(repo.id, scan, rows, (row) => row.id)
}

/** Resolution owns durable identity stamping; memory projection never calls this wrapper. */
export function joinRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  let projectedMeta: Record<string, WorktreeMeta> | undefined
  if (!isFolderRepo(repo)) {
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
