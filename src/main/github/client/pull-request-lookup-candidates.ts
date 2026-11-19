import type { IssueSourcePreference } from '../../../shared/repository/repo-types'
import type { LocalGitExecOptions } from '../repositories/github-repository-identity'
import { getOriginGitHubApiRepository } from '../repositories/github-api-repository-remote-probe'
import {
  resolveGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates
} from '../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../shared/github/repositories/repository-identity'
import { getGitHubItemUrlRepository } from '../../../shared/worktree/github-linked-item-url'
import { foldWwwHostAlias } from '../../../shared/git/remotes/git-remote-host-alias'
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

/** A caller-pinned repository (CI-line watch or saved linked PR URL): its configured remote, or the
 *  repository itself when no remote names it, never another remote probed by number. Absent, every
 *  candidate. */
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

/** The saved linked PR URL's repository, host-verified like any caller-supplied repository. */
export async function linkedPRUrlRepository(
  repoPath: string,
  linkedPRUrl: string | undefined,
  linkedPRNumber: number | null | undefined,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GitHubApiRepository | undefined> {
  const repository = getGitHubItemUrlRepository(linkedPRUrl, 'pr', linkedPRNumber)
  if (!repository) {
    return undefined
  }
  // Pasted links may say www.github.com; the API host is github.com.
  const host =
    foldWwwHostAlias(repository.host ?? '') === 'github.com' ? 'github.com' : repository.host
  const verified = await resolveGitHubApiRepository(
    repoPath,
    { ...repository, host },
    connectionId,
    localGitOptions
  )
  // An unverifiable host keeps git-remote discovery, as for links without a saved URL.
  return verified ?? undefined
}
