import type { ClassifiedError } from '../../../../shared/classified-error'
import { classifyGitHubUnavailable } from '../../../../shared/github/api-availability'
import { parseTaskQuery, type ParsedTaskQuery } from '../../../../shared/task-query'
import { sortWorkItemsByNumber } from '../../../../shared/work-items'
import {
  classifyListIssuesError,
  classifyListPrsError,
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions,
  type OwnerRepo
} from '../../gh-utils'
import { githubHostExecOptions } from '../../github-api-repository'
import { githubPRStackExecutionScope } from './../github-exec-scope'
import { hydrateWorkItemRepositoryMergeMetadata } from './../detect/hydrate-work-item-merge-metadata'
import type { MainWorkItem } from './../map/work-item-field-coercion'
import {
  assertSshRepoHasResolvedGitHubSource,
  type PartialWorkItemsResult
} from './work-item-list-request'
import { listIssueWorkItemPage } from './work-item-issue-page'
import { listPullRequestWorkItemPage } from './work-item-pr-page'
export async function listRecentWorkItems(
  repoPath: string,
  issueOwnerRepo: OwnerRepo | null,
  prOwnerRepo: OwnerRepo | null,
  limit: number,
  page: number,
  connectionId?: string | null,
  noCache?: boolean,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  assertSshRepoHasResolvedGitHubSource({ connectionId, issueOwnerRepo, prOwnerRepo })
  const recentQuery = parseTaskQuery('is:open')
  // Isolate missing sources to avoid global searches, and retain successful halves on partial failure.
  const [issuesSettled, prsSettled] = await Promise.allSettled([
    issueOwnerRepo
      ? listIssueWorkItemPage({
          repoPath,
          ownerRepo: issueOwnerRepo,
          query: recentQuery,
          limit,
          page,
          options: { ...ghOptions, ...githubHostExecOptions(issueOwnerRepo) },
          connectionId,
          localGitOptions,
          noCache
        })
      : Promise.resolve([]),
    prOwnerRepo
      ? listPullRequestWorkItemPage({
          ownerRepo: prOwnerRepo,
          query: recentQuery,
          limit,
          page,
          options: { ...ghOptions, ...githubHostExecOptions(prOwnerRepo) },
          noCache
        })
      : Promise.resolve([])
  ])

  let issues: MainWorkItem[] = []
  let issuesError: ClassifiedError | undefined
  if (issuesSettled.status === 'fulfilled') {
    issues = issuesSettled.value
  } else {
    const stderr =
      issuesSettled.reason instanceof Error
        ? issuesSettled.reason.message
        : String(issuesSettled.reason)
    issuesError = classifyListIssuesError(stderr)
  }

  let prs: MainWorkItem[] = []
  if (prsSettled.status === 'fulfilled') {
    prs = prsSettled.value
    prs = await hydrateWorkItemRepositoryMergeMetadata(
      prs,
      prOwnerRepo,
      { ...ghOptions, ...githubHostExecOptions(prOwnerRepo) },
      githubPRStackExecutionScope(connectionId, localGitOptions)
    )
  } else {
    // Log the issue error before propagating the PR failure to the cross-repo aggregator.
    if (issuesError) {
      console.warn(
        'listRecentWorkItems: both issue and PR sides failed; issuesError was classified:',
        issuesError.type,
        issuesError.message
      )
    }
    throw prsSettled.reason
  }

  return {
    items: sortWorkItemsByNumber([...issues, ...prs]).slice(0, limit),
    issuesError
  }
}

export async function listQueriedWorkItems(
  repoPath: string,
  issueOwnerRepo: OwnerRepo | null,
  prOwnerRepo: OwnerRepo | null,
  query: ParsedTaskQuery,
  limit: number,
  page?: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  noCache?: boolean
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  assertSshRepoHasResolvedGitHubSource({ connectionId, issueOwnerRepo, prOwnerRepo })
  const hasPrOnlyFilter =
    query.state === 'merged' ||
    query.draft ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
  const issueScope = query.scope !== 'pr' && !hasPrOnlyFilter
  const prScope = query.scope !== 'issue'
  let successfulRequestCount = 0
  let nonAvailabilityFailureCount = 0
  let availabilityError: unknown
  let prsError: ClassifiedError | undefined

  // Preserve classified issue-side failure alongside partial PR results.
  const issueFetch = (async (): Promise<PartialWorkItemsResult> => {
    if (!issueScope) {
      return { items: [] }
    }
    if (!issueOwnerRepo) {
      return { items: [] }
    }
    try {
      const items = await listIssueWorkItemPage({
        repoPath,
        ownerRepo: issueOwnerRepo,
        query,
        limit,
        page: page ?? 1,
        options: { ...ghOptions, ...githubHostExecOptions(issueOwnerRepo) },
        connectionId,
        localGitOptions,
        noCache
      })
      successfulRequestCount += 1
      return { items }
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      if (classifyGitHubUnavailable(stderr)) {
        availabilityError = err
      } else {
        nonAvailabilityFailureCount += 1
      }
      return { items: [], issuesError: classifyListIssuesError(stderr) }
    }
  })()

  const prFetch = (async (): Promise<MainWorkItem[]> => {
    if (!prScope) {
      return []
    }
    if (!prOwnerRepo) {
      return []
    }
    try {
      const mapped = await listPullRequestWorkItemPage({
        ownerRepo: prOwnerRepo,
        limit,
        query,
        page: page ?? 1,
        options: { ...ghOptions, ...githubHostExecOptions(prOwnerRepo) },
        noCache
      })
      const hydrated = await hydrateWorkItemRepositoryMergeMetadata(
        mapped,
        prOwnerRepo,
        { ...ghOptions, ...githubHostExecOptions(prOwnerRepo) },
        githubPRStackExecutionScope(connectionId, localGitOptions)
      )
      successfulRequestCount += 1
      if (query.state === 'closed') {
        return hydrated.filter((item) => item.state !== 'merged')
      }
      return hydrated
    } catch (err) {
      console.warn('listQueriedWorkItems PRs partial failure:', err)
      const stderr = err instanceof Error ? err.message : String(err)
      prsError = classifyListPrsError(stderr)
      if (classifyGitHubUnavailable(stderr)) {
        availabilityError ??= err
      } else {
        nonAvailabilityFailureCount += 1
      }
      return []
    }
  })()

  const [issueResult, prItems] = await Promise.all([issueFetch, prFetch])
  if (availabilityError && successfulRequestCount === 0 && nonAvailabilityFailureCount === 0) {
    // Shared availability failure across both halves means an outage, not an empty result.
    throw availabilityError
  }
  return {
    items: sortWorkItemsByNumber([...issueResult.items, ...prItems]).slice(0, limit),
    issuesError: issueResult.issuesError,
    prsError
  }
}
