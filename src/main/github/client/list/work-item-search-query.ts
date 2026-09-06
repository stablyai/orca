import { isDefaultGitHubHost } from '../../../../shared/github/repository-identity-key'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
// Why: issue numbers follow creation order, so this sort aligns gh's PR rows with numbered Search API issue pages.
export const WORK_ITEM_NUMBER_SORT_QUALIFIER = 'sort:created-desc'

/**
 * Build a `search/issues` path. On github.com, pin advanced search only when
 * a dependency qualifier (`is:blocked` / `-is:blocked`) is present — classic
 * lexical search reinterprets those as free text (spurious matches). Leave
 * ordinary queries on classic search so result sets stay unchanged.
 * GHES never gets advanced search: issue dependencies are github.com-only.
 */
export function buildIssueSearchIssuesApiPath(args: {
  query: string
  perPage: number
  page?: number
  sort?: 'created'
  order?: 'desc' | 'asc'
  host?: string
  /** True when the query includes an is:blocked / -is:blocked qualifier. */
  blockedQualifier?: boolean
}): string {
  const params = [`q=${encodeURIComponent(args.query)}`]
  if (args.sort) {
    params.push(`sort=${args.sort}`)
  }
  if (args.order) {
    params.push(`order=${args.order}`)
  }
  params.push(`per_page=${args.perPage}`)
  if (args.page !== undefined) {
    params.push(`page=${args.page}`)
  }
  if (args.blockedQualifier && isDefaultGitHubHost(args.host)) {
    params.push('advanced_search=true')
  }
  return `search/issues?${params.join('&')}`
}

/** Why: blocked-by is issue-only and only honored under github.com advanced search. */
export function shouldEmitBlockedSearchQualifier(args: {
  host?: string
  /** Issue list/count paths only; PR search never gets advanced_search. */
  forIssues: boolean
  blocked: boolean | null
}): boolean {
  return args.forIssues && args.blocked !== null && isDefaultGitHubHost(args.host)
}

export function buildSearchQueryString(
  ownerRepo: { owner: string; repo: string; host?: string },
  query: ParsedTaskQuery
): string {
  const parts: string[] = [`repo:${ownerRepo.owner}/${ownerRepo.repo}`]
  if (query.scope === 'pr') {
    parts.push('is:pull-request')
  } else if (query.scope === 'issue') {
    parts.push('is:issue')
  }
  if (query.state === 'open') {
    parts.push('is:open')
  } else if (query.state === 'closed') {
    // Why: GitHub search treats merged PRs as closed; exclude merged so "Closed" means closed-without-merge.
    parts.push('is:closed')
    if (query.scope !== 'issue') {
      parts.push('-is:merged')
    }
  } else if (query.state === 'merged') {
    parts.push('is:merged')
  }
  if (query.draft) {
    parts.push('draft:true')
  }
  if (
    shouldEmitBlockedSearchQualifier({
      host: ownerRepo.host,
      forIssues: query.scope !== 'pr',
      blocked: query.blocked
    })
  ) {
    parts.push(query.blocked === true ? 'is:blocked' : '-is:blocked')
  }
  if (query.assignee) {
    parts.push(`assignee:${quoteGitHubSearchValue(query.assignee)}`)
  }
  if (query.author) {
    parts.push(`author:${quoteGitHubSearchValue(query.author)}`)
  }
  if (query.reviewRequested) {
    parts.push(`review-requested:${quoteGitHubSearchValue(query.reviewRequested)}`)
  }
  if (query.reviewedBy) {
    parts.push(`reviewed-by:${quoteGitHubSearchValue(query.reviewedBy)}`)
  }
  for (const label of query.labels) {
    parts.push(`label:${quoteGitHubSearchValue(label)}`)
  }
  if (query.freeText) {
    parts.push(query.freeText)
  }
  return parts.join(' ')
}

export function quoteGitHubSearchValue(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value
}

export function defaultOpenWorkItemQuery(): ParsedTaskQuery {
  return {
    scope: 'all',
    state: 'open',
    draft: false,
    blocked: null,
    assignee: null,
    author: null,
    reviewRequested: null,
    reviewedBy: null,
    labels: [],
    freeText: ''
  }
}
