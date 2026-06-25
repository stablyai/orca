import type { Repo } from '../shared/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'

type RepoIdentityStore = {
  getRepos(): Repo[]
  updateRepo(id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>): Repo | null
}

export async function enrichMissingRepoGitRemoteIdentities(
  store: RepoIdentityStore
): Promise<boolean> {
  let changed = false
  const candidates = store
    .getRepos()
    .filter((repo) => repo.kind !== 'folder' && !repo.gitRemoteIdentity)

  for (const repo of candidates) {
    const identity = await detectGitRemoteIdentity(repo.path, repo.connectionId)
    if (!identity) {
      continue
    }
    if (store.updateRepo(repo.id, { gitRemoteIdentity: identity })) {
      changed = true
    }
  }
  return changed
}
