import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import type { ParsedTaskQuery } from '../../shared/task-query'

/** Repository qualifier used by one Search API query. */
export type WorkItemSearchRepository = Pick<GitHubOwnerRepo, 'owner' | 'repo'> & { host?: string }

export type WorkItemSearchScope = 'all' | 'issue' | 'pr'

// Why: GitHub's request-URL ceiling is lower than the existing free-text query
// bound. Keep headroom for endpoint parameters, proxies, and longer Enterprise
// host paths; chunking is preferable to turning a valid selection into a 414.
export const DEFAULT_WORK_ITEM_SEARCH_MAX_REQUEST_BYTES = 7_500

function quoteGitHubSearchValue(value: string): string {
  return /^[A-Za-z0-9@*_./-]+$/.test(value)
    ? value
    : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function repositoryQualifier(repository: WorkItemSearchRepository): string {
  return `repo:${repository.owner}/${repository.repo}`
}

function normalizedRepositories(
  repositories: readonly WorkItemSearchRepository[]
): WorkItemSearchRepository[] {
  const unique = new Map<string, WorkItemSearchRepository>()
  for (const repository of repositories) {
    const key = githubRepoIdentityKey(repository)
    if (!unique.has(key)) {
      unique.set(key, repository)
    }
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = githubRepoIdentityKey(left)
    const rightKey = githubRepoIdentityKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function buildWorkItemSearchQuery(
  repositories: readonly WorkItemSearchRepository[],
  query: ParsedTaskQuery,
  scope: WorkItemSearchScope
): string {
  const normalized = normalizedRepositories(repositories)
  if (normalized.length === 0) {
    throw new Error('GitHub work-item search requires at least one repository')
  }

  const parts = normalized.map(repositoryQualifier)
  if (scope === 'issue') {
    parts.push('is:issue')
  } else if (scope === 'pr') {
    parts.push('is:pr')
  }

  if (query.state === 'open') {
    parts.push('is:open')
  } else if (query.state === 'closed') {
    parts.push('is:closed')
    if (scope !== 'issue') {
      parts.push('-is:merged')
    }
  } else if (query.state === 'merged') {
    parts.push('is:merged')
  }

  if (scope !== 'issue' && query.draft) {
    parts.push('draft:true')
  }
  if (query.assignee) {
    parts.push(`assignee:${quoteGitHubSearchValue(query.assignee)}`)
  }
  if (query.author) {
    parts.push(`author:${quoteGitHubSearchValue(query.author)}`)
  }
  for (const label of query.labels) {
    parts.push(`label:${quoteGitHubSearchValue(label)}`)
  }
  if (scope !== 'issue' && query.reviewRequested) {
    parts.push(`review-requested:${quoteGitHubSearchValue(query.reviewRequested)}`)
  }
  if (scope !== 'issue' && query.reviewedBy) {
    parts.push(`reviewed-by:${quoteGitHubSearchValue(query.reviewedBy)}`)
  }
  if (query.freeText) {
    parts.push(query.freeText)
  }
  return parts.join(' ')
}

/**
 * Estimate the complete Search API request URL passed to `gh api`.
 * `encodeURIComponent` is deliberate: GitHub receives the encoded query, not
 * the JavaScript string length.
 */
export function estimateWorkItemSearchRequestBytes(
  query: string,
  page: number,
  perPage: number
): number {
  const request = `search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=${perPage}&page=${page}`
  return new TextEncoder().encode(request).length
}

export function splitWorkItemSearchRepositories(
  repositories: readonly WorkItemSearchRepository[],
  query: ParsedTaskQuery,
  scope: WorkItemSearchScope,
  options: {
    maxRequestBytes?: number
    page?: number
    perPage?: number
  } = {}
): WorkItemSearchRepository[][] {
  const normalized = normalizedRepositories(repositories)
  if (normalized.length === 0) {
    return []
  }
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_WORK_ITEM_SEARCH_MAX_REQUEST_BYTES
  const page = options.page ?? 1
  const perPage = options.perPage ?? 100
  const chunks: WorkItemSearchRepository[][] = []
  let current: WorkItemSearchRepository[] = []

  for (const repository of normalized) {
    const candidate = [...current, repository]
    const candidateQuery = buildWorkItemSearchQuery(candidate, query, scope)
    const candidateBytes = estimateWorkItemSearchRequestBytes(candidateQuery, page, perPage)
    if (candidateBytes <= maxRequestBytes) {
      current = candidate
      continue
    }
    if (current.length > 0) {
      chunks.push(current)
      const soloQuery = buildWorkItemSearchQuery([repository], query, scope)
      if (estimateWorkItemSearchRequestBytes(soloQuery, page, perPage) > maxRequestBytes) {
        throw new Error(
          `GitHub repository qualifier exceeds Search API request budget: ${repository.owner}/${repository.repo}`
        )
      }
      current = [repository]
      continue
    }
    if (candidateBytes > maxRequestBytes) {
      throw new Error(
        `GitHub repository qualifier exceeds Search API request budget: ${repository.owner}/${repository.repo}`
      )
    }
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}
