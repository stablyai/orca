import { preserveFolderUpgradeWorktreePath } from '../folder-upgrade-worktree-path'
import {
  composeWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey
} from '../../shared/worktree/id'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../persistence/host-qualified-worktree-meta'
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

import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { resolveLocalProjectRuntimesForRepos } from '../project-runtime-git-options'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

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
  /** Folder workspaces are stamped from runtime-owned identity helpers, so the caller supplies them. */
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
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
    if (!parsed || parsed.repoId !== repo.id) {
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
export type RepoWorktreeRowsScan = { ok: boolean; worktrees: GitWorktreeInfo[] }

/** The scan half of `resolveRepoWorktreeRows`: slow, and the only part that awaits. */
export async function scanRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'scanRepo'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRowsScan> {
  const { store } = deps
  // Absorb rejection before withTimeout: rejection preserves shipped empty results, but timeout restores last-known rows.
  const scan: RuntimeWorktreeScanResult = (await withTimeout<RuntimeWorktreeScanResult | null>(
    deps
      .scanRepo(repo, projectRuntimeByRepoId)
      .catch(() => ({ ok: false, worktrees: [] }) satisfies RuntimeWorktreeScanResult),
    RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
    null
  )) ?? { ok: false, worktrees: listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount) }
  const gitWorktrees = preserveFolderUpgradeWorktreePath(repo, scan.worktrees)
  if (scan.ok) {
    pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
  }
  return { ok: scan.ok, worktrees: gitWorktrees }
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
      displayName: merged.displayName,
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
  const ownerRows = await resolveRepoWorktreeRows(
    deps,
    repo,
    store.getAllWorktreeMeta() ?? {},
    resolveLocalProjectRuntimesForRepos(store, [repo])
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
  const relatedRepos = store
    .getRepos()
    .filter(
      (candidate) =>
        relatedRepoIds.has(candidate.id) && getRepoExecutionHostId(candidate) === hostId
    )
  if (new Set(relatedRepos.map((candidate) => candidate.id)).size !== relatedRepos.length) {
    return null
  }
  const metaById = store.getAllWorktreeMeta() ?? {}
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, relatedRepos)
  const otherRows = await Promise.all(
    relatedRepos.map((relatedRepo) =>
      resolveRepoWorktreeRows(deps, relatedRepo, metaById, projectRuntimeByRepoId)
    )
  )
  const projected = projectResolvedWorktreeLineage([...ownerRows, ...otherRows.flat()], lineageById)
  return projected[ownerRows.indexOf(target)] ?? null
}
