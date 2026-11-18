import {
  splitWorktreeIdForFilesystem,
  composeWorktreeId,
  worktreeIdentityKey
} from '../../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  getConnectedWorktreeLineageIds,
  projectResolvedWorktreeLineage
} from '../../../../shared/worktree/lineage/resolved-worktree-lineage'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import {
  projectRepoWorktreeRows,
  scanRepoWorktreeRows,
  stampRepoWorktreeRows,
  type RepoWorktreeRow,
  type RepoWorktreeRowDeps,
  type RepoWorktreeRowsScan
} from './repo-worktree-row-resolution'

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
  const ownerCount = repoOwners.rowsFor(repo.id).length
  const ownerScan = isFolderRepo(repo)
    ? null
    : await scanRepoWorktreeRows(
        deps,
        repo,
        resolveLocalProjectRuntimesForRepos(store, [repo]),
        ownerCount
      )
  // Stamp the whole scan as a full join would; only the projection below is narrowed.
  const metaById = store.getAllWorktreeMeta() ?? {}
  const ownerStamped = stampRepoWorktreeRows(deps, repo, ownerScan, metaById, ownerCount)
  // Accept one normalized equivalent id; multiple path matches remain ambiguous (#16243).
  const comparisonKey = worktreeIdentityKey(worktreeId)
  const equivalentIds = new Set(
    (ownerScan?.worktrees ?? [])
      .map((git) => composeWorktreeId(repo.id, git.path))
      .filter((id) => worktreeIdentityKey(id) === comparisonKey)
  )
  const projectOwner = (keep: (id: string) => boolean): RepoWorktreeRow[] =>
    projectRepoWorktreeRows(
      deps,
      repo,
      scanRowsWhere(repo, ownerScan, keep),
      metaById,
      ownerCount,
      ownerStamped
    )
  const candidates = projectOwner((id) => equivalentIds.has(id))
  const exact = candidates.find((worktree) => worktree.id === worktreeId)
  const equivalent = candidates.filter(
    (worktree) => worktreeIdentityKey(worktree.id) === comparisonKey
  )
  const target = exact ?? (equivalent.length === 1 ? equivalent[0] : null)
  if (!target) {
    return null
  }
  const lineageById = store.getAllWorktreeLineage?.() ?? {}
  const relatedIds = getConnectedWorktreeLineageIds([target.id], lineageById)
  // Lineage links only rows in the target's connected component, so other rows cannot change it.
  const ownerRows =
    ownerScan && relatedIds.size > 1
      ? projectOwner((id) => relatedIds.has(id) || equivalentIds.has(id))
      : candidates
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
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, relatedRepos)
  const otherRows = await Promise.all(
    relatedRepos.map(async (relatedRepo) => {
      const count = relatedOwners.rowsFor(relatedRepo.id).length
      const scan = isFolderRepo(relatedRepo)
        ? null
        : await scanRepoWorktreeRows(deps, relatedRepo, projectRuntimeByRepoId, count)
      const stamped = stampRepoWorktreeRows(deps, relatedRepo, scan, metaById, count)
      const kept = scanRowsWhere(relatedRepo, scan, (id) => relatedIds.has(id))
      return projectRepoWorktreeRows(deps, relatedRepo, kept, metaById, count, stamped)
    })
  )
  const projected = projectResolvedWorktreeLineage([...ownerRows, ...otherRows.flat()], lineageById)
  return projected[ownerRows.findIndex((row) => row.id === target.id)] ?? null
}

/** The scan limited to the Git checkouts `keep` admits; a folder repo has no scan to narrow. */
function scanRowsWhere(
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  keep: (worktreeId: string) => boolean
): RepoWorktreeRowsScan | null {
  return (
    scan && {
      ...scan,
      worktrees: scan.worktrees.filter((git) => keep(composeWorktreeId(repo.id, git.path)))
    }
  )
}
