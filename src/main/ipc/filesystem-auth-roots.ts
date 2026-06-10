import { resolve } from 'path'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/types'

export function getLocalRepoAllowedRoots(repo: Repo): string[] {
  const roots = [resolve(repo.path)]
  if (!isFolderRepo(repo) && repo.worktreeFolderPath) {
    roots.push(resolve(repo.worktreeFolderPath))
  }
  return roots
}
