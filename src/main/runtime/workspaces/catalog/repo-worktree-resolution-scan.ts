import type { Repo } from '../../../../shared/repo-types'
import type { RepoWorktreeRowStore } from './repo-worktree-row-resolution'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { gitWorktreeObservationReader } from '../../../workspaces/catalog/git-worktree-observations'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export type RuntimeWorktreeScanAttempt = RuntimeWorktreeScanResult & {
  superseded?: boolean
  isCurrent?: () => boolean
}

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}

/** Publish last-known persisted rows on unreachable/stalled scans, matching disconnected SSH listing behavior. */
export function listStoredWorktreeRowsForRepo(
  store: RepoWorktreeRowStore,
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): GitWorktreeInfo[] {
  const expectedHostId = getRepoExecutionHostId(repo)
  const byWorktreeId = new Map<string, GitWorktreeInfo>()
  const readObservation = gitWorktreeObservationReader(store, repo)
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
      ...readObservation(meta),
      ...(meta.sparseDirectories !== undefined ||
      meta.sparseBaseRef !== undefined ||
      meta.sparsePresetId !== undefined
        ? { isSparse: true }
        : {})
    })
  }
  return [...byWorktreeId.values()]
}
