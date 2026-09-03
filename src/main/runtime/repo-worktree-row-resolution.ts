import {
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdComparisonKey
} from '../../shared/worktree/id'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost,
  writeWorktreeMetaForHost
} from '../persistence/host-qualified-worktree-meta'
import { isFolderRepo } from '../../shared/repo-kind'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Store } from '../persistence'
import { areWorktreePathsEqual, mergeWorktree } from '../ipc/worktree-logic'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { resolveLocalProjectRuntimesForRepos } from '../project-runtime-git-options'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

/**
 * Per-repo budget for one resolution pass. Why: mobile startup shares this path, so one slow repo
 * degrades its own metadata instead of blocking all session loading.
 *
 * Exported because the Git-admin fingerprint probe derives its own timeout by subtracting a fallback
 * allowance from this, and that invariant only holds with a single source of truth.
 */
export const RESOLVED_WORKTREE_REPO_TIMEOUT_MS = 5000

/**
 * One repo's resolved row. Builders emit it with the lineage fields empty; `projectResolvedWorktreeLineage`
 * fills them in. `lineage` is nullable rather than `null` so a projected row still types honestly —
 * intersecting a `null` literal would collapse the projected type back to "never has lineage".
 */
export type RepoWorktreeRow = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: Pick<GitWorktreeInfo, 'path' | 'head' | 'branch' | 'isBare' | 'isMainWorktree'>
}

export type RepoWorktreeRowDeps = {
  store: Store
  /** The cache-aware per-repo scan. Injected so this module never owns scan-cache state. */
  scanRepo: (
    repo: Repo,
    projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ) => Promise<RuntimeWorktreeScanResult>
  /** Folder workspaces are stamped from runtime-owned identity helpers, so the caller supplies them. */
  listFolderWorkspaces: (repo: Repo, repoOwnerCount: number) => Worktree[]
}

/**
 * Persisted rows for a repo whose scan is unreachable or stalled, so a degraded host publishes what
 * it last knew instead of an empty catalog. `worktrees:list` does the same for disconnected SSH.
 */
export function listStoredWorktreeRowsForRepo(
  store: Store,
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
    // Why: one repo id can be registered on several execution hosts, so a degraded host must not republish another host's rows (same gate as worktrees.ts).
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

/** One repo's worktree rows before lineage projection. Shared by the fleet scan and scoped lookups. */
export async function resolveRepoWorktreeRows(
  deps: RepoWorktreeRowDeps,
  repo: Repo,
  metaById: Record<string, WorktreeMeta>,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRow[]> {
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
  // Why the catch: `withTimeout` resolves its fallback on rejection too, so the rejection must be absorbed
  // first for `null` to mean "timed out" only. A stall never reached a verdict, so restore persisted rows
  // instead of publishing a healthy-looking empty catalog; a rejection is a real answer and keeps its
  // shipped zero-row semantics.
  const scan: RuntimeWorktreeScanResult = (await withTimeout<RuntimeWorktreeScanResult | null>(
    deps
      .scanRepo(repo, projectRuntimeByRepoId)
      .catch(() => ({ ok: false, worktrees: [] }) satisfies RuntimeWorktreeScanResult),
    RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
    null
  )) ?? { ok: false, worktrees: listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount) }
  const gitWorktrees = scan.worktrees
  if (scan.ok) {
    pruneLineageForMissingRepoWorktrees(store, repo, gitWorktrees)
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  return gitWorktrees.map((gitWorktree) => {
    const worktreeId = `${repo.id}::${gitWorktree.path}`
    // Why: lineage validation needs a durable instance ID even when the runtime sees a workspace before renderer discovery-stamp.
    const existingMeta = metaById[worktreeId]
    // A host-qualified row is exact; the locator-keyed one is only trustworthy when this repo owns it.
    const ownedExistingMeta =
      readWorktreeMetaForHost(store, worktreeId, expectedHostId) ??
      getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
    const meta = ownedExistingMeta?.instanceId
      ? ownedExistingMeta
      : ownedExistingMeta || (!existingMeta && repoOwnerCount === 1)
        ? writeWorktreeMetaForHost(store, worktreeId, expectedHostId, {})
        : undefined
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

/**
 * Resolve one `<repoId>::<path>` worktree id by scanning only its owning repo.
 *
 * Cross-repo lineage needs every repo on the host, so affected rows return `null` and let the caller
 * fall back to its fleet scan. Other rows retain the cheap scoped path.
 */
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
  const comparisonKey = worktreeIdComparisonKey(worktreeId)
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const touchesCrossRepoLineage = Object.values(lineageById).some((lineage) => {
    const touchesRequestedWorktree =
      lineage.worktreeId === worktreeId ||
      lineage.parentWorktreeId === worktreeId ||
      (comparisonKey !== null &&
        (worktreeIdComparisonKey(lineage.worktreeId) === comparisonKey ||
          worktreeIdComparisonKey(lineage.parentWorktreeId) === comparisonKey))
    if (!touchesRequestedWorktree) {
      return false
    }
    const child = splitWorktreeId(lineage.worktreeId)
    const parent = splitWorktreeId(lineage.parentWorktreeId)
    if (child?.repoId === parent?.repoId) {
      return false
    }
    // Why: lineage IDs are host-unqualified. A colliding edge on another host must not force this
    // host's otherwise-scoped lookup into a fleet fallback that cannot resolve the target row.
    if (requiredHostId !== undefined && typeof store.getWorktreeMetaForHost === 'function') {
      const childMeta = readWorktreeMetaForHost(store, lineage.worktreeId, requiredHostId)
      const parentMeta = readWorktreeMetaForHost(store, lineage.parentWorktreeId, requiredHostId)
      return (
        childMeta?.instanceId === lineage.worktreeInstanceId &&
        parentMeta?.instanceId === lineage.parentWorktreeInstanceId
      )
    }
    return true
  })
  if (touchesCrossRepoLineage) {
    return null
  }
  const owners = store
    .getRepos()
    .filter(
      (repo) =>
        repo.id === parsed.repoId &&
        (requiredHostId === undefined || getRepoExecutionHostId(repo) === requiredHostId)
    )
  // Why: one repo id can be registered on several execution hosts, and only the fleet scan decides
  // between unqualified rows. A host qualifier narrows the same-id set without scanning other owners.
  if (owners.length !== 1) {
    return null
  }
  const repo = owners[0]
  const rows = await resolveRepoWorktreeRows(
    deps,
    repo,
    store.getAllWorktreeMeta() ?? {},
    resolveLocalProjectRuntimesForRepos(store, [repo])
  )
  const projected = projectResolvedWorktreeLineage(rows, lineageById)
  const exact = projected.find((worktree) => worktree.id === worktreeId)
  if (exact) {
    return exact
  }
  // Why (#16243): the scan can spell this id's path differently — the divergence `path:` absorbs.
  // One equivalent row may stand in; two is an ambiguity a scoped lookup must refuse, not guess.
  if (comparisonKey === null) {
    return null
  }
  const equivalent = projected.filter(
    (worktree) => worktreeIdComparisonKey(worktree.id) === comparisonKey
  )
  return equivalent.length === 1 ? equivalent[0] : null
}
