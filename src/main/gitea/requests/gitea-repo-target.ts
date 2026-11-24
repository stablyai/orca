import { getGiteaRepoRef, type GiteaLocalGitOptions, type GiteaRepoRef } from '../repository-ref'

/** Where a repo-scoped Gitea call reads the origin remote: path, SSH connection and WSL options. */
export type GiteaRepoTarget = {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: GiteaLocalGitOptions
}

export function resolveGiteaRepoTarget(target: GiteaRepoTarget): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRef(target.repoPath, target.connectionId, target.localGitOptions)
}
