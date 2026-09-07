import type { IssueSourcePreference } from '../../../shared/repo-types'
import type { LocalGitExecOptions } from '../gh-utils'
import {
  getOriginGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates,
  type GitHubApiRepository
} from '../github-api-repository'
// resolvePrWorkItemSource list semantics.
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
