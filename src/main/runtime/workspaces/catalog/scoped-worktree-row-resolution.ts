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
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
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
  // Accept one normalized equivalent id; multiple path matches remain ambiguous (#16243).
  const comparisonKey = worktreeIdentityKey(worktreeId)
  const equivalentIds = new Set(
    ownerScan ? (scanRowIndex(repo, ownerScan.worktrees).byIdentity.get(comparisonKey) ?? []) : []
  )
  if (ownerScan?.ok && equivalentIds.size === 0) {
    return null
  }
  // Stamp the whole scan as a full join would; only the projection below is narrowed.
  const metaById = store.getAllWorktreeMeta() ?? {}
  const ownerStamped = stampRepoWorktreeRows(deps, repo, ownerScan, metaById, ownerCount)
  const projectOwner = (ids: ReadonlySet<string>): RepoWorktreeRow[] =>
    projectRepoWorktreeRows(
      deps,
      repo,
      scanRowsWithIds(repo, ownerScan, ids),
      metaById,
      ownerCount,
      ownerStamped
    )
  const candidates = projectOwner(equivalentIds)
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
  // Each repo reads only its own lineage ids, so a component spanning many repos isn't read once per repo.
  const relatedIdsByRepo = new Map<string, Set<string>>()
  for (const id of relatedIds) {
    const repoId = splitWorktreeIdForFilesystem(id)?.repoId
    if (repoId !== undefined) {
      relatedIdsByRepo.set(repoId, (relatedIdsByRepo.get(repoId) ?? new Set()).add(id))
    }
  }
  // Lineage links only rows in the target's connected component, so other rows cannot change it.
  const ownerRows =
    ownerScan && relatedIds.size > 1
      ? projectOwner(new Set([...(relatedIdsByRepo.get(repo.id) ?? []), ...equivalentIds]))
      : candidates
  const relatedRepoIds = new Set(relatedIdsByRepo.keys())
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
      const kept = scanRowsWithIds(
        relatedRepo,
        scan,
        relatedIdsByRepo.get(relatedRepo.id) ?? new Set()
      )
      return projectRepoWorktreeRows(deps, relatedRepo, kept, metaById, count, stamped)
    })
  )
  const projected = projectResolvedWorktreeLineage([...ownerRows, ...otherRows.flat()], lineageById)
  return projected[ownerRows.findIndex((row) => row.id === target.id)] ?? null
}

type ScanRowIndex = {
  /** Scan positions by composed worktree id. */
  byId: Map<string, number[]>
  /** Composed worktree ids by identity key, in scan order. */
  byIdentity: Map<string, string[]>
}

// Observed scans are never mutated, so each is keyed once and later lookups read only their own rows.
const scanRowIndexes = new WeakMap<readonly GitWorktreeInfo[], Map<string, ScanRowIndex>>()

function scanRowIndex(repo: Repo, worktrees: readonly GitWorktreeInfo[]): ScanRowIndex {
  let byRepo = scanRowIndexes.get(worktrees)
  if (!byRepo) {
    byRepo = new Map()
    scanRowIndexes.set(worktrees, byRepo)
  }
  let index = byRepo.get(repo.id)
  if (!index) {
    index = { byId: new Map(), byIdentity: new Map() }
    for (const [position, git] of worktrees.entries()) {
      const id = composeWorktreeId(repo.id, git.path)
      const positions = index.byId.get(id)
      if (positions) {
        positions.push(position)
        continue
      }
      index.byId.set(id, [position])
      const key = worktreeIdentityKey(id)
      const spellings = index.byIdentity.get(key)
      if (spellings) {
        spellings.push(id)
      } else {
        index.byIdentity.set(key, [id])
      }
    }
    byRepo.set(repo.id, index)
  }
  return index
}

/** The scan limited to the Git checkouts with these ids, in scan order; a folder repo has no scan to narrow. */
function scanRowsWithIds(
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  ids: ReadonlySet<string>
): RepoWorktreeRowsScan | null {
  if (!scan) {
    return null
  }
  const { byId } = scanRowIndex(repo, scan.worktrees)
  const positions = [...ids].flatMap((id) => byId.get(id) ?? []).sort((a, b) => a - b)
  return { ...scan, worktrees: positions.map((position) => scan.worktrees[position]) }
}
