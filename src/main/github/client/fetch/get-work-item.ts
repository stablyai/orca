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
  getIssueDetailsViaGraphQL,
  type CollapsedIssueDetails
} from '../../issue-work-item-details'
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
  const { item } = await getWorkItemWithRepository(
    repoPath,
    number,
    type,
    connectionId,
    localGitOptions,
    preference
  )
  return item
}

export type WorkItemRepositoryLookup = {
  item: MainWorkItem | null
  repository: GitHubApiRepository | null
  issueDetails?: CollapsedIssueDetails | null
}

export async function getWorkItemWithRepository(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference,
  includeIssueDetails = false
): Promise<WorkItemRepositoryLookup> {
  await acquire()
  try {
    // Number-based issue lookup must honor the same selected source as its list.
    if (type === 'issue') {
      const { source } = await resolveIssueGitHubApiRepositorySource(
        repoPath,
        preference,
        connectionId,
        localGitOptions
      )
      // Explicit origin cannot fall back to ambient gh repository discovery.
      if (!source && preference === 'origin') {
        return { item: null, repository: null }
      }
      const issueDetails =
        includeIssueDetails && source
          ? await getIssueDetailsViaGraphQL(
              repoPath,
              number,
              source,
              connectionId,
              localGitOptions,
              true
            )
          : undefined
      return {
        item:
          issueDetails?.item ??
          (await fetchIssueWorkItem(repoPath, source, number, connectionId, localGitOptions)),
        repository: source,
        ...(includeIssueDetails ? { issueDetails } : {})
      }
    }
    if (type === 'pr') {
      return {
        item: await fetchPullRequestWorkItemFromCandidates(
          repoPath,
          number,
          connectionId,
          localGitOptions,
          preference
        ),
        repository: null
      }
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
          return { item: issue, repository: source }
        }
      }
    } catch (err) {
      // Only genuine issue 404s permit trying a same-number PR; preserve transient failures.
      const stderr = err instanceof Error ? err.message : String(err)
      if (classifyGhError(stderr).type !== 'not_found') {
        throw err
      }
    }
    return {
      item: await fetchPullRequestWorkItemFromCandidates(
        repoPath,
        number,
        connectionId,
        localGitOptions,
        preference
      ),
      repository: null
    }
  } catch {
    return { item: null, repository: null }
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
  // Pasted hosts must match configured remotes before receiving credentials.
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
