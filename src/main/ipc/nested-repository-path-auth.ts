import { resolve } from 'node:path'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Store } from '../persistence'
import { isDescendantOrEqual, normalizeExistingPath } from './filesystem-path-containment'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

export async function resolveNestedRepositoryPath(
  repositoryPath: string,
  parentFolderPath: string,
  store: Store
): Promise<string> {
  const registeredParent = await resolveRegisteredWorktreePath(parentFolderPath, store)
  const ownsFolder = store
    .getRepos()
    .some((repo) => isFolderRepo(repo) && resolve(repo.path) === registeredParent)
  if (!ownsFolder) {
    throw new Error('Access denied: nested repository parent is not a registered folder')
  }

  const [canonicalParent, canonicalRepository] = await Promise.all([
    normalizeExistingPath(registeredParent),
    normalizeExistingPath(resolve(repositoryPath))
  ])
  if (
    canonicalRepository === canonicalParent ||
    !isDescendantOrEqual(canonicalRepository, canonicalParent)
  ) {
    throw new Error('Access denied: repository is outside the registered folder')
  }
  return canonicalRepository
}
