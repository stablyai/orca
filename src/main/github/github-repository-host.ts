import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'

export function githubHostExecOptions(repository: GitHubOwnerRepo | null | undefined): {
  host?: string
} {
  return repository?.host ? { host: repository.host } : {}
}

export function githubRepositoryWebHost(repository: GitHubOwnerRepo): string {
  return repository.host ?? 'github.com'
}

/** Host-qualified positional slug for commands that bypass the runner's `--repo`. */
export function githubRepositorySlugArg(repository: GitHubOwnerRepo): string {
  const slug = `${repository.owner}/${repository.repo}`
  // Why: pin dotcom too so process-level GH_HOST cannot redirect the request.
  return repository.host ? `${repository.host}/${slug}` : slug
}
