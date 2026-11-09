import type { IssueSourcePreference } from '../../../shared/repo-types'
import type { LocalGitExecOptions } from '../gh-utils'
import { isDefaultGitHubHost } from '../../../shared/github/repository-identity-key'
import { sameOwnerRepo } from './github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './lookup/pull-request-lookup-data'
import {
  getOriginGitHubApiRepository,
  resolveGitHubApiRepository,
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

export type PullRequestRepositories = {
  candidates: GitHubApiRepository[]
  /** The PR's expected head: the pushed repository when given, else the checkout's origin. */
  headRepo: GitHubApiRepository | null
  /** The pushed head repository once its host may receive credentials; null when absent or unverified. */
  readableHead: GitHubApiRepository | null
}

/** A linked or watched PR's own repository: its configured remote, or the repository itself when no
 *  remote names it, never another remote probed by number. Absent, every candidate. A repository no
 *  remote names can come from an attachment URL or a push's `To` line, so its Enterprise host must be
 *  authenticated before receiving ambient credentials; null when the exact repository's is not. */
export async function pullRequestRepositoryCandidates(
  { exactRepository: exact, headRepository: head }: GitHubPRBranchLookupOptions,
  context: { repoPath: string; connectionId?: string | null; localGitOptions: LocalGitExecOptions }
): Promise<PullRequestRepositories | null> {
  const { repoPath, connectionId, localGitOptions } = context
  const resolved = await resolveGitHubApiRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions
  )
  const { candidates } = resolved
  const headRepo = head ?? resolved.headRepo
  const configured = (repo: GitHubApiRepository) =>
    candidates.some((candidate) => sameOwnerRepo(candidate, repo))
  const verified = async (repo: GitHubApiRepository) =>
    isDefaultGitHubHost(repo.host) ||
    (await resolveGitHubApiRepository(repoPath, repo, connectionId, localGitOptions)) !== null
  const readableHead = head && (configured(head) || (await verified(head))) ? head : null
  if (!exact) {
    return {
      candidates:
        readableHead && !configured(readableHead) ? [...candidates, readableHead] : candidates,
      headRepo,
      readableHead
    }
  }
  const matches = candidates.filter((candidate) => sameOwnerRepo(candidate, exact))
  if (matches.length > 0) {
    return { candidates: matches, headRepo, readableHead }
  }
  return (await verified(exact)) ? { candidates: [exact], headRepo, readableHead } : null
}
