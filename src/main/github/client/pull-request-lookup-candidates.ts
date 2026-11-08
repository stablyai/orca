import type { IssueSourcePreference } from '../../../shared/repo-types'
import type { LocalGitExecOptions } from '../gh-utils'
import {
  getOriginGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates,
  type GitHubApiRepository
} from '../github-api-repository'
export async function resolvePullRequestLookupCandidates(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository[]> {
  if (preference === 'origin') {
    const origin = await getOriginGitHubApiRepository(repoPath, connectionId, localGitOptions)
    return origin ? [origin] : []
  }
  return (await resolveGitHubApiRepositoryCandidates(repoPath, connectionId, localGitOptions))
    .candidates
}

/** A CI-line watch's own PR repository: its configured remote, or the repository itself when no
 *  remote names it, never another remote probed by number. Absent, every candidate. */
export function exactRepositoryCandidates(
  candidates: GitHubApiRepository[],
  exact: GitHubApiRepository | undefined
): GitHubApiRepository[] {
  if (!exact) {
    return candidates
  }
  const matches = candidates.filter(
    (candidate) =>
      candidate.owner.toLowerCase() === exact.owner.toLowerCase() &&
      candidate.repo.toLowerCase() === exact.repo.toLowerCase() &&
      (candidate.host ?? 'github.com').toLowerCase() === (exact.host ?? 'github.com').toLowerCase()
  )
  return matches.length > 0 ? matches : [exact]
}
