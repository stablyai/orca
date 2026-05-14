import { basename } from 'path'
import type { Repo } from '../shared/types'
import { splitWorktreeId } from '../shared/worktree-id'
import type { Store } from './persistence'

export type UsageWorktreeRef = {
  worktreeId: string
  path: string
  displayName: string
}

function getDefaultUsageWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}

export function loadKnownUsageWorktreesByRepo(
  store: Pick<Store, 'getAllWorktreeMeta'>,
  repos: Repo[]
): Map<string, UsageWorktreeRef[]> {
  const localRepos = repos.filter((repo) => !repo.connectionId)
  const repoIds = new Set(localRepos.map((repo) => repo.id))
  const worktreesByRepo = new Map<string, UsageWorktreeRef[]>()
  const seenPathsByRepo = new Map<string, Set<string>>()

  for (const repo of localRepos) {
    worktreesByRepo.set(repo.id, [
      {
        worktreeId: `${repo.id}::${repo.path}`,
        path: repo.path,
        displayName: repo.displayName || getDefaultUsageWorktreeLabel(repo.path)
      }
    ])
    seenPathsByRepo.set(repo.id, new Set([repo.path]))
  }

  // Why: usage scans are background/opt-in analytics. Do not spawn
  // `git worktree list` here; it can re-touch macOS protected folders.
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed || !repoIds.has(parsed.repoId)) {
      continue
    }
    const seenPaths = seenPathsByRepo.get(parsed.repoId)
    if (seenPaths?.has(parsed.worktreePath)) {
      continue
    }
    seenPaths?.add(parsed.worktreePath)
    worktreesByRepo.get(parsed.repoId)?.push({
      worktreeId,
      path: parsed.worktreePath,
      displayName: meta.displayName || getDefaultUsageWorktreeLabel(parsed.worktreePath)
    })
  }

  return worktreesByRepo
}
