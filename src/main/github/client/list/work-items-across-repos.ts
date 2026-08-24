import type { ListWorkItemsAcrossReposResult } from '../../../../shared/github/work-item-types'
import {
  isGitHubWorkItemsQueryTooLarge,
  MAX_GITHUB_WORK_ITEMS_BATCH_REPOS
} from '../../../../shared/github/work-items-query-bounds'
import { classifyGitHubUnavailable } from '../../../../shared/github/api-availability'
import { parseTaskQuery } from '../../../../shared/task-query'
import { classifyListIssuesError, type LocalGitExecOptions } from '../../gh-utils'
import { resolveIssueGitHubApiRepositorySource } from '../../github-api-repository'
import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { normalizeWorkItemPage, resolvePrWorkItemSource } from './work-item-list-request'
import { executeBatchSearchPlan, hydrateBatchPullRequests } from './batch-execute'
import {
  addBatchSource,
  batchExecutionKey,
  batchItemComparator,
  batchSearchPlans,
  mergeBatchSearchOutcomes,
  type BatchSearchGroup,
  type ResolvedBatchRepo
} from './batch-search'

export type GitHubWorkItemsBatchInput = {
  repoId: string
  repoPath: string
  connectionId?: string | null
  preference?: IssueSourcePreference
  localGitOptions?: LocalGitExecOptions
}

export type GitHubWorkItemResolutionFailure = {
  repoId: string
  reason: unknown
}

export async function listWorkItemsAcrossRepos(
  inputs: readonly GitHubWorkItemsBatchInput[],
  limit = 24,
  query?: string,
  page?: number,
  noCache = false,
  resolutionFailures: readonly GitHubWorkItemResolutionFailure[] = []
): Promise<ListWorkItemsAcrossReposResult> {
  if (inputs.length > MAX_GITHUB_WORK_ITEMS_BATCH_REPOS) {
    throw new Error(
      `GitHub work-item selection exceeds the ${MAX_GITHUB_WORK_ITEMS_BATCH_REPOS}-repository limit`
    )
  }
  const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const requestedPage = normalizeWorkItemPage(page)
  const trimmedQuery = query?.trim() ?? ''
  if (isGitHubWorkItemsQueryTooLarge(trimmedQuery)) {
    return {
      items: [],
      totalCount: 0,
      reachableCount: 0,
      failedCount: 0,
      githubUnavailable: false,
      errorTypes: ['validation_error'],
      queryTooLarge: true
    }
  }
  const parsedQuery = parseTaskQuery(trimmedQuery || 'is:open')
  const resolutionResults = await Promise.allSettled(
    inputs.map(async (input): Promise<ResolvedBatchRepo> => {
      const [issueResolved, prResolved] = await Promise.allSettled([
        resolveIssueGitHubApiRepositorySource(
          input.repoPath,
          input.preference,
          input.connectionId,
          input.localGitOptions
        ),
        resolvePrWorkItemSource(
          input.repoPath,
          input.preference,
          input.connectionId,
          input.localGitOptions
        )
      ])
      return {
        ...input,
        issueSource: issueResolved.status === 'fulfilled' ? issueResolved.value.source : null,
        issueSourceFellBack:
          issueResolved.status === 'fulfilled' ? issueResolved.value.fellBack : false,
        prSource: prResolved.status === 'fulfilled' ? prResolved.value.source : null,
        originCandidate:
          prResolved.status === 'fulfilled' ? prResolved.value.originCandidate : null,
        upstreamCandidate:
          prResolved.status === 'fulfilled' ? prResolved.value.upstreamCandidate : null,
        resolutionFailures: [
          ...(issueResolved.status === 'rejected'
            ? [{ repoId: input.repoId, reason: issueResolved.reason }]
            : []),
          ...(prResolved.status === 'rejected'
            ? [{ repoId: input.repoId, reason: prResolved.reason }]
            : [])
        ]
      }
    })
  )
  const resolvedRepos: ResolvedBatchRepo[] = []
  const allResolutionFailures = [...resolutionFailures]
  for (const [index, result] of resolutionResults.entries()) {
    if (result.status === 'fulfilled') {
      resolvedRepos.push(result.value)
      allResolutionFailures.push(...result.value.resolutionFailures)
    } else {
      allResolutionFailures.push({
        repoId: inputs[index]?.repoId ?? 'unknown',
        reason: result.reason
      })
    }
  }
  const resolutionErrorTypes = allResolutionFailures.map(({ reason }) =>
    classifyListIssuesError(reason instanceof Error ? reason.message : String(reason))
  )
  let failedCount = resolutionErrorTypes.length
  let unavailableCount = resolutionErrorTypes.filter((error) =>
    classifyGitHubUnavailable(error.message)
  ).length
  const resolvedById = new Map(resolvedRepos.map((repo) => [repo.repoId, repo]))
  const sourcesByRepo = Object.fromEntries(
    resolvedRepos
      .filter(
        (repo) =>
          repo.issueSource !== null ||
          repo.prSource !== null ||
          repo.resolutionFailures.length === 0
      )
      .map((repo) => [
        repo.repoId,
        {
          issues: repo.issueSource,
          prs: repo.prSource,
          originCandidate: repo.originCandidate,
          upstreamCandidate: repo.upstreamCandidate,
          ...(repo.issueSourceFellBack ? { issueSourceFellBack: true as const } : {})
        }
      ])
  )
  const groups = new Map<string, BatchSearchGroup>()
  for (const repo of resolvedRepos) {
    for (const [kind, source] of [
      ['issue', repo.issueSource],
      ['pr', repo.prSource]
    ] as const) {
      if (!source) {
        continue
      }
      const key = batchExecutionKey(repo, source)
      const group = groups.get(key) ?? {
        key,
        anchor: repo,
        issueSources: new Map(),
        prSources: new Map()
      }
      addBatchSource(group, kind, source, repo)
      groups.set(key, group)
    }
  }
  const plans = batchSearchPlans([...groups.values()], parsedQuery)
  if (plans.length === 0) {
    return {
      items: [],
      totalCount: 0,
      reachableCount: 0,
      failedCount,
      githubUnavailable: failedCount > 0 && unavailableCount === failedCount,
      ...(resolutionErrorTypes.length > 0
        ? { errorTypes: resolutionErrorTypes.map((error) => error.type) }
        : {}),
      ...(Object.keys(sourcesByRepo).length > 0 ? { sourcesByRepo } : {})
    }
  }
  // A page after the first may need a prefix when chunking is introduced; the
  // conservative prefix keeps page jumps correct until query-plan metadata is
  // cached across calls.
  const usePrefix = plans.length > 1 || requestedPage > 1
  const outcomes = await Promise.all(
    plans.map((plan) =>
      executeBatchSearchPlan(plan, parsedQuery, requestedPage, normalizedLimit, noCache, usePrefix)
    )
  )
  const items = outcomes.flatMap((outcome) => outcome.items).sort(batchItemComparator)
  const merged = mergeBatchSearchOutcomes(outcomes, resolutionErrorTypes)
  failedCount += merged.failedCount
  unavailableCount += merged.unavailableCount
  const visible = usePrefix
    ? items.slice((requestedPage - 1) * normalizedLimit, requestedPage * normalizedLimit)
    : items.slice(0, normalizedLimit)
  return {
    items: await hydrateBatchPullRequests(visible, resolvedById),
    totalCount: merged.totalCount,
    failedCount,
    reachableCount: merged.reachableCount,
    githubUnavailable:
      failedCount > 0 && unavailableCount === failedCount && !merged.hasSuccessfulRequest,
    ...(merged.errorTypes.length > 0 ? { errorTypes: merged.errorTypes } : {}),
    ...(merged.searchWindowLimited ? { searchWindowLimited: true as const } : {}),
    ...(merged.queryTooLarge ? { queryTooLarge: true as const } : {}),
    ...(Object.keys(sourcesByRepo).length > 0 ? { sourcesByRepo } : {})
  }
}
