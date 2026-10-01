import { isFolderRepo } from '../shared/repo-kind'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { Store } from './persistence'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from './project-runtime-git-options'
import type {
  RetiredPreparationSweepRepo,
  RetiredPreparationSweepTargets
} from './retired-worktree-create-preparation-sweep'
import { parseWslPath } from './wsl'

/**
 * Local repos only. A WSL repo's spare folder is skipped: resolving its root can block the main
 * thread on `wsl.exe`, and its Git recorded Linux paths this process cannot follow. Its locked
 * spares are still reclaimed through its registrations, by its own Git.
 */
export function collectRetiredPreparationSweepTargets(
  store: Store
): RetiredPreparationSweepTargets {
  const settings = store.getSettings()
  const workspaceRoots = new Set<string>()
  const repos: RetiredPreparationSweepRepo[] = []
  for (const repo of store.getRepos()) {
    if (repo.connectionId || isFolderRepo(repo)) {
      continue
    }
    let gitOptions: LocalProjectWorktreeGitOptions
    try {
      gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
    } catch {
      // A project runtime awaiting repair runs no Git.
      continue
    }
    repos.push({ path: repo.path, ...gitOptions })
    if (parseWslPath(repo.path) || gitOptions.wslDistro) {
      continue
    }
    try {
      const workspaceRoot = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings))
      if (!parseWslPath(workspaceRoot)) {
        workspaceRoots.add(workspaceRoot)
      }
    } catch {
      // A repo with an unusable configured base path never had a spare folder there.
    }
  }
  return { workspaceRoots: [...workspaceRoots], repos }
}
