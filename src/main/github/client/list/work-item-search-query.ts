import type { ParsedTaskQuery } from '../../../../shared/task-query'
// Why: issue numbers follow creation order, so this sort aligns gh's PR rows with numbered Search API issue pages.
export const WORK_ITEM_NUMBER_SORT_QUALIFIER = 'sort:created-desc'

export function buildSearchQueryString(
  ownerRepo: { owner: string; repo: string },
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
    assignee: null,
    author: null,
    reviewRequested: null,
    reviewedBy: null,
    labels: [],
    freeText: ''
  }
}
