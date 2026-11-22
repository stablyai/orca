import {
  withGitHubRepoExecution,
  type LocalGitExecOptions
} from '../../repositories/github-repository-identity'
import type { IssueSourcePreference } from '../../../../shared/repository/repo-types'
import { acquire, release } from '../../execution/github-operation-slots'
import { classifyGhError } from '../../api/gh-error-classification'
import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'

import { resolveIssueGitHubApiRepositorySource } from '../../repositories/github-api-repository'
import { resolveGitHubWorkItemLinkRepository } from '../../repositories/github-work-item-link-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import type { MainWorkItem } from './../map/work-item-field-coercion'
import {
  getIssueDetailsViaGraphQL,
  type CollapsedIssueDetails
} from '../../issues/issue-work-item-details'
import {
  fetchIssueWorkItem,
  fetchPullRequestWorkItem,
  fetchPullRequestWorkItemFromCandidates
} from './work-item-fetch'
import { fetchWorkItemPreview } from './work-item-preview'

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
  {
    includeIssueDetails = false,
    includeChecksSummary
  }: {
    includeIssueDetails?: boolean
    includeChecksSummary?: boolean
  } = {}
): Promise<WorkItemRepositoryLookup> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
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
            preference,
            { includeChecksSummary }
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
          preference,
          { includeChecksSummary }
        ),
        repository: null
      }
    } catch {
      return { item: null, repository: null }
    } finally {
      release()
    }
  })
}

export async function getWorkItemByOwnerRepo(
  repoPath: string,
  ownerRepo: GitHubApiRepository,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { preview?: boolean } = {}
): Promise<MainWorkItem | null> {
  const { item } = await getWorkItemWithExactRepository(
    repoPath,
    ownerRepo,
    number,
    type,
    connectionId,
    localGitOptions,
    options
  )
  return item
}

export async function getWorkItemWithExactRepository(
  repoPath: string,
  ownerRepo: GitHubApiRepository,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: {
    preview?: boolean
    issueDetails?: { fresh: boolean }
    includeChecksSummary?: boolean
  } = {}
): Promise<WorkItemRepositoryLookup> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const matchedRepository = await resolveGitHubWorkItemLinkRepository(
      repoPath,
      ownerRepo,
      { allowSameHost: options.preview },
      connectionId,
      localGitOptions
    )
    if (!matchedRepository) {
      return { item: null, repository: null }
    }
    await acquire()
    try {
      if (options.preview) {
        return {
          item: await fetchWorkItemPreview(
            repoPath,
            matchedRepository,
            number,
            type,
            connectionId,
            localGitOptions
          ),
          repository: matchedRepository
        }
      }
      if (type === 'issue') {
        const issueDetails = options.issueDetails
          ? await getIssueDetailsViaGraphQL(
              repoPath,
              number,
              matchedRepository,
              connectionId,
              localGitOptions,
              true,
              options.issueDetails.fresh
            )
          : undefined
        return {
          item:
            issueDetails?.item ??
            (await fetchIssueWorkItem(
              repoPath,
              matchedRepository,
              number,
              connectionId,
              localGitOptions
            )),
          repository: matchedRepository,
          issueDetails
        }
      }
      return {
        item: await fetchPullRequestWorkItem(
          repoPath,
          matchedRepository,
          number,
          connectionId,
          localGitOptions,
          options
        ),
        repository: matchedRepository
      }
    } catch (err) {
      // Only the failure class is logged: stderr and the command line name the repository.
      const stderr = extractExecError(err).stderr || (err instanceof Error ? err.message : '')
      console.warn(
        `getWorkItemByOwnerRepo ${options.preview ? 'preview' : type} lookup failed: ${classifyGhError(stderr).type}`
      )
      return { item: null, repository: null }
    } finally {
      release()
    }
  })
}
