import type { ClassifiedError } from '../../../../shared/classified-error'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { classifyGitHubUnavailable } from '../../../../shared/github/api-availability'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { classifyListIssuesError } from '../../gh-utils'
import { mapIssueWorkItem, mapPullRequestWorkItem } from '../map/work-item'
import { fetchPullRequestWorkItem } from '../fetch/work-item-fetch'
import {
  buildWorkItemSearchQuery,
  splitWorkItemSearchRepositories,
  type WorkItemSearchRepository
} from '../../work-item-search-query'
import {
  batchItemComparator,
  fetchSearchResponse,
  type BatchSearchOutcome,
  type BatchSearchPlan,
  type ResolvedBatchRepo
} from './batch-search'

function repositoryFullNameFromUrl(value: string, kind: 'api' | 'html'): string | null {
  try {
    const pathname = new URL(value).pathname
    const parts = pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    const reposIndex = kind === 'api' ? parts.indexOf('repos') : -1
    const start = reposIndex >= 0 ? reposIndex + 1 : 0
    return parts[start] && parts[start + 1] ? `${parts[start]}/${parts[start + 1]}` : null
  } catch {
    return null
  }
}

function searchRepositoryKeyFromItem(
  item: Record<string, unknown>,
  sourceHost?: string
): string | null {
  let fullName: string | null = null
  const repository = item.repository
  if (typeof repository === 'object' && repository !== null) {
    const candidate = (repository as { full_name?: unknown }).full_name
    if (typeof candidate === 'string') {
      fullName = candidate
    }
  }
  if (!fullName && typeof item.repository_url === 'string') {
    fullName = repositoryFullNameFromUrl(item.repository_url, 'api')
  }
  if (!fullName && typeof item.html_url === 'string') {
    fullName = repositoryFullNameFromUrl(item.html_url, 'html')
  }
  if (!fullName) {
    return null
  }
  const [owner, repo] = fullName.split('/')
  if (!owner || !repo) {
    return null
  }
  return githubRepoIdentityKey({ owner, repo, host: sourceHost })
}

export async function executeBatchSearchPlan(
  plan: BatchSearchPlan,
  query: ParsedTaskQuery,
  page: number,
  limit: number,
  noCache: boolean,
  usePrefix: boolean
): Promise<BatchSearchOutcome> {
  const repositories = [...plan.sources.values()].map(({ source }) => source)
  let chunks: WorkItemSearchRepository[][]
  try {
    chunks = splitWorkItemSearchRepositories(repositories, query, plan.scope, {
      page: 1,
      perPage: 100
    })
  } catch (err) {
    console.warn('[workItems] grouped Search API planning failed:', err)
    return {
      items: [],
      totalCount: 0,
      reachableCount: 0,
      failedCount: 1,
      unavailableCount: 0,
      errorTypes: ['validation_error'],
      hasSuccessfulRequest: false,
      searchWindowLimited: false,
      queryTooLarge: true
    }
  }

  const prefixSize = Math.min(1000, Math.max(1, page * limit))
  const chunkResults = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const chunkQuery = buildWorkItemSearchQuery(chunk, query, plan.scope)
      if (!usePrefix && chunks.length === 1) {
        return await fetchSearchResponse(plan.group, chunkQuery, page, limit, noCache)
      }
      const pageCount = Math.ceil(prefixSize / 100)
      const pages = await Promise.all(
        Array.from({ length: pageCount }, (_, index) =>
          fetchSearchResponse(plan.group, chunkQuery, index + 1, 100, noCache)
        )
      )
      return {
        items: pages.flatMap((result) => result.items).slice(0, prefixSize),
        totalCount: pages[0]?.totalCount ?? 0
      }
    })
  )

  let totalCount = 0
  let reachableCount = 0
  let failedCount = 0
  let unavailableCount = 0
  const errorTypes: ClassifiedError['type'][] = []
  const items: GitHubWorkItem[] = []
  let hasSuccessfulRequest = false
  let searchWindowLimited = false
  let queryTooLarge = false
  for (let index = 0; index < chunkResults.length; index += 1) {
    const result = chunkResults[index]
    if (result.status === 'rejected') {
      failedCount += 1
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
      const classified = classifyListIssuesError(message)
      errorTypes.push(classified.type)
      if (classifyGitHubUnavailable(message)) {
        unavailableCount += 1
      }
      queryTooLarge ||= /request budget/i.test(message)
      continue
    }
    hasSuccessfulRequest = true
    totalCount += result.value.totalCount
    reachableCount += Math.min(result.value.totalCount, 1000)
    searchWindowLimited ||= result.value.totalCount > 1000
    const sourceMap = new Map(
      chunks[index].map((source) => [
        githubRepoIdentityKey(source),
        plan.sources.get(githubRepoIdentityKey(source))!
      ])
    )
    for (const raw of result.value.items) {
      const isPR = 'pull_request' in raw
      if ((plan.scope === 'issue' && isPR) || (plan.scope === 'pr' && !isPR)) {
        continue
      }
      const sourceKey = searchRepositoryKeyFromItem(raw, chunks[index][0]?.host)
      const member = sourceKey ? sourceMap.get(sourceKey) : undefined
      if (!member) {
        continue
      }
      const mapped = isPR ? mapPullRequestWorkItem(raw, member.source) : mapIssueWorkItem(raw)
      items.push({ ...mapped, repoId: member.repo.repoId })
    }
  }

  const ordered = items.sort(batchItemComparator)
  return {
    // Multi-stream callers need the prefix so the caller can perform one
    // global merge. A single Search API stream is already globally ordered.
    items: usePrefix ? ordered : ordered.slice(0, limit),
    totalCount,
    reachableCount,
    failedCount,
    unavailableCount,
    errorTypes,
    hasSuccessfulRequest,
    searchWindowLimited,
    queryTooLarge
  }
}

export async function hydrateBatchPullRequests(
  items: GitHubWorkItem[],
  resolvedRepos: ReadonlyMap<string, ResolvedBatchRepo>
): Promise<GitHubWorkItem[]> {
  const hydrated = [...items]
  const pending = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'pr')
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const current = pending[next]
      next += 1
      const resolved = resolvedRepos.get(current.item.repoId)
      if (!resolved?.prSource) {
        continue
      }
      try {
        const detail = await fetchPullRequestWorkItem(
          resolved.repoPath,
          resolved.prSource,
          current.item.number,
          resolved.connectionId,
          resolved.localGitOptions
        )
        if (detail) {
          hydrated[current.index] = { ...detail, repoId: current.item.repoId }
        }
      } catch (err) {
        // Why: list rows remain useful when optional visible-row hydration hits
        // a rate limit, deleted fork, or provider-specific field failure.
        console.warn(
          `[workItems] PR hydration failed for ${current.item.repoId}#${current.item.number}:`,
          err
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()))
  return hydrated
}
