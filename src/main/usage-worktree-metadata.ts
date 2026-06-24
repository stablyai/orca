import { basename } from 'path'
import type { Repo } from '../shared/types'
import {
  makeRepoWorktreeKey,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../shared/worktree-id'
import { isFolderRepo } from '../shared/repo-kind'
import type { Store } from './persistence'
import { getRepoExecutionHostId } from '../shared/execution-host'

export type UsageWorktreeRef = {
  worktreeId: string
  path: string
  displayName: string
}

function getDefaultUsageWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}

export function getUsageRepoKey(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.id}`
}

export function loadKnownUsageWorktreesByRepo(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  repos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  const localRepos = repos.filter((repo) => !repo.connectionId)
  const worktreesByRepo = new Map<string, UsageWorktreeRef[]>()
  const seenPathsByRepo = new Map<string, Set<string>>()

  for (const repo of localRepos) {
    const repoKey = getUsageRepoKey(repo)
    worktreesByRepo.set(repoKey, [
      {
        worktreeId: makeRepoWorktreeKey(repo, repo.path),
        path: repo.path,
        displayName: repo.displayName || getDefaultUsageWorktreeLabel(repo.path)
      }
    ])
    seenPathsByRepo.set(repoKey, new Set([repo.path]))
  }

  // Why: usage scans are background/opt-in analytics. Do not spawn
  // `git worktree list` here; it can re-touch macOS protected folders.
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      continue
    }
    const matchingRepos = localRepos.filter((item) => {
      if (item.id !== parsed.repoId) {
        return false
      }
      return parsed.hostId === undefined || getRepoExecutionHostId(item) === parsed.hostId
    })
    if (matchingRepos.length !== 1) {
      continue
    }
    const [repo] = matchingRepos
    const repoKey = getUsageRepoKey(repo)
    const worktreePath =
      repo && isFolderRepo(repo)
        ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? parsed.worktreePath)
        : parsed.worktreePath
    const seenPaths = seenPathsByRepo.get(repoKey)
    if (seenPaths?.has(worktreePath)) {
      continue
    }
    seenPaths?.add(worktreePath)
    worktreesByRepo.get(repoKey)?.push({
      worktreeId,
      path: worktreePath,
      displayName: meta.displayName || getDefaultUsageWorktreeLabel(worktreePath)
    })
  }

  return worktreesByRepo
}
