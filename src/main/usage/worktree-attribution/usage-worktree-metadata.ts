import { basename } from 'node:path'
import type { Repo } from '../../../shared/repo-types'
import {
  getRepoMainWorktreeId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../shared/worktree/id'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getRepoRoutingConnectionId } from '../../../shared/execution-host'
import { canonicalWorktreePath } from '../../git/worktrees/catalog/worktree-path-comparison'

export type UsageWorktreeRef = {
  worktreeId: string
  path: string
  displayName: string
}

function getDefaultUsageWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}

export type UsageWorktreeSource = {
  getRepos: () => Repo[]
  getAllWorktreeMeta: () => Record<string, Pick<WorktreeMeta, 'displayName'>>
  /** Worktrees seen before, removed ones included, keyed by id with their display names. */
  getRememberedWorktreeDisplayNames: () => ReadonlyMap<string, string>
  /** Resolves once remembered worktrees are read; attribution before that would drop removed ones. */
  whenLoaded: () => Promise<void>
}

export function loadKnownUsageWorktreesByRepo(
  store: Pick<UsageWorktreeSource, 'getAllWorktreeMeta' | 'getRememberedWorktreeDisplayNames'>,
  repos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  const localRepos = repos.filter((repo) => !getRepoRoutingConnectionId(repo))
  const localReposById = new Map<string, Repo>()
  for (const repo of localRepos) {
    const repoId = repo.id
    // Preserve the first match if corrupt state repeats a repo id.
    if (!localReposById.has(repoId)) {
      localReposById.set(repoId, repo)
    }
  }
  const worktreesByRepo = new Map<string, UsageWorktreeRef[]>()
  const seenPathsByRepo = new Map<string, Set<string>>()

  for (const repo of localRepos) {
    worktreesByRepo.set(repo.id, [
      {
        worktreeId: getRepoMainWorktreeId(repo),
        path: repo.path,
        displayName: repo.displayName || getDefaultUsageWorktreeLabel(repo.path)
      }
    ])
    seenPathsByRepo.set(repo.id, new Set([repo.path]))
  }

  const claimedPaths = new Set(localRepos.map((repo) => canonicalWorktreePath(repo.path)))
  const addWorktree = (worktreeId: string, displayName: string, remembered: boolean): void => {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      return
    }
    const repo = localReposById.get(parsed.repoId)
    if (!repo) {
      return
    }
    const worktreePath = isFolderRepo(repo)
      ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? parsed.worktreePath)
      : parsed.worktreePath
    const seenPaths = seenPathsByRepo.get(parsed.repoId)
    const canonicalPath = canonicalWorktreePath(worktreePath)
    // Live rows claim paths first, so a reused path is never credited to a removed worktree.
    if (seenPaths?.has(worktreePath) || (remembered && claimedPaths.has(canonicalPath))) {
      return
    }
    seenPaths?.add(worktreePath)
    claimedPaths.add(canonicalPath)
    worktreesByRepo.get(parsed.repoId)?.push({
      worktreeId,
      path: worktreePath,
      displayName: displayName || getDefaultUsageWorktreeLabel(worktreePath)
    })
  }

  // Background analytics must not spawn git scans that re-touch macOS protected folders.
  const liveMeta = store.getAllWorktreeMeta()
  for (const [worktreeId, meta] of Object.entries(liveMeta)) {
    addWorktree(worktreeId, meta.displayName, false)
  }
  for (const [worktreeId, displayName] of store.getRememberedWorktreeDisplayNames()) {
    if (!Object.hasOwn(liveMeta, worktreeId)) {
      addWorktree(worktreeId, displayName, true)
    }
  }

  return worktreesByRepo
}
