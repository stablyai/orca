import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import { getLocalFolderScopeRoots, getLocalRepos } from './filesystem-folder-scope-roots'

export { getLocalRepos }

export function getAllowedRoots(store: Store): string[] {
  const localRepos = getLocalRepos(store)
  const settings = store.getSettings()
  const roots = [
    ...localRepos.map((repo) => resolve(repo.path)),
    ...getLocalFolderScopeRoots(store)
  ]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      roots.push(resolve(settings.workspaceDir))
    } else {
      for (const repo of localRepos) {
        roots.push(
          resolve(computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings)))
        )
      }
    }
  }
  return roots
}
