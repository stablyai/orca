import type { GitHubProjectViewError } from '../../../shared/github/projects/project-result-types'
import { githubProjectHost } from '../../../shared/github/projects/project-identity'
import { isDefaultGitHubHost } from '../../../shared/github/repositories/repository-identity-key'
import { isGitHubHostAuthenticatedForGlobalCli } from '../repositories/github-enterprise-repository'

/** Project View uses ambient login, independently of Repo.ghAccount; pin Enterprise hosts explicitly. */
export type ProjectGhExecOptions = { cwd?: string; host?: string }

// Owner/project calls have no repository slug, so pin their host directly.
export function projectGhExecOptions(host: string | undefined): ProjectGhExecOptions {
  return { host: githubProjectHost(host) }
}

export async function projectHostAuthenticationError(
  host: string | undefined
): Promise<GitHubProjectViewError | null> {
  const selectedHost = githubProjectHost(host)
  if (
    isDefaultGitHubHost(selectedHost) ||
    (await isGitHubHostAuthenticatedForGlobalCli(selectedHost))
  ) {
    return null
  }
  // Verify pasted hosts before sending ambient Enterprise credentials.
  return {
    type: 'auth_required',
    message: `GitHub CLI is not authenticated to ${selectedHost}. Run gh auth login --hostname ${selectedHost}.`,
    host: selectedHost
  }
}
