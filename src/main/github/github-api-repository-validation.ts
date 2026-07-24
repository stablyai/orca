import type { GitHubOwnerRepo } from '../../shared/types'

const GITHUB_OWNER_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const GITHUB_REPO_SLUG_RE = /^[A-Za-z0-9._-]+$/

// Why: renderer/RPC overrides are interpolated into authenticated REST paths.
export function isValidGitHubApiRepository(repository: GitHubOwnerRepo): boolean {
  return (
    GITHUB_OWNER_SLUG_RE.test(repository.owner) &&
    GITHUB_REPO_SLUG_RE.test(repository.repo) &&
    repository.repo !== '.' &&
    repository.repo !== '..'
  )
}
