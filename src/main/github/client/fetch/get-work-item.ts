import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { acquire, release, classifyGhError, type LocalGitExecOptions } from '../../gh-utils'
import {
  resolveGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates,
  resolveIssueGitHubApiRepositorySource,
  type GitHubApiRepository
} from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import type { MainWorkItem } from './../map/work-item-field-coercion'
import {
  fetchIssueWorkItem,
  fetchPullRequestWorkItem,
  fetchPullRequestWorkItemFromCandidates
} from './work-item-fetch'
export async function getWorkItem(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<MainWorkItem | null> {
  await acquire()
  try {
    // Why: listWorkItems uses resolveIssueGitHubApiRepositorySource; open-by-number
    // must share that preference so origin/upstream toggles cannot disagree.
    if (type === 'issue') {
      const { source } = await resolveIssueGitHubApiRepositorySource(
        repoPath,
        preference,
        connectionId,
        localGitOptions
      )
      // Why: explicit origin with no origin identity must not bare-lookup ambient gh
      // (same fail-closed rule as origin-pinned PR candidate resolution).
      if (!source && preference === 'origin') {
        return null
      }
      return await fetchIssueWorkItem(repoPath, source, number, connectionId, localGitOptions)
    }
    if (type === 'pr') {
      return await fetchPullRequestWorkItemFromCandidates(
        repoPath,
        number,
        connectionId,
        localGitOptions,
        preference
      )
    }

    try {
      const { source } = await resolveIssueGitHubApiRepositorySource(
        repoPath,
        preference,
        connectionId,
        localGitOptions
      )
      if (source || preference !== 'origin') {
        const issue = await fetchIssueWorkItem(
          repoPath,
          source,
          number,
          connectionId,
          localGitOptions
        )
        if (issue) {
          return issue
        }
      }
    } catch (err) {
      // Why: only fall through to PR #N on a genuine 404; re-throw transient errors so a flake can't surface an unrelated PR.
      const stderr = err instanceof Error ? err.message : String(err)
      if (classifyGhError(stderr).type !== 'not_found') {
        throw err
      }
    }
    return await fetchPullRequestWorkItemFromCandidates(
      repoPath,
      number,
      connectionId,
      localGitOptions,
      preference
    )
  } catch {
    return null
  } finally {
    release()
  }
}

export async function getWorkItemByOwnerRepo(
  repoPath: string,
  ownerRepo: GitHubApiRepository,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  const requestedHost = ownerRepo.host?.trim().toLowerCase()
  const requestedRepository = requestedHost
    ? { ...ownerRepo, host: requestedHost }
    : await resolveGitHubApiRepository(repoPath, ownerRepo, connectionId, localGitOptions)
  if (!requestedRepository) {
    return null
  }
  const { candidates } = await resolveGitHubApiRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions
  )
  const requestedKey = githubRepoIdentityKey(requestedRepository)
  const matchedRepository = candidates.find(
    (candidate) => githubRepoIdentityKey(candidate) === requestedKey
  )
  // Why: this lookup is reachable from pasted links. Restricting it to a
  // configured remote prevents gh from sending credentials to an arbitrary host.
  if (!matchedRepository) {
    return null
  }
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueWorkItem(
        repoPath,
        matchedRepository,
        number,
        connectionId,
        localGitOptions
      )
    }
    return await fetchPullRequestWorkItem(
      repoPath,
      matchedRepository,
      number,
      connectionId,
      localGitOptions
    )
  } catch {
    return null
  } finally {
    release()
  }
}
