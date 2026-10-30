import type { IssueSourcePreference } from '../../../../shared/repo-types'
import { isGitHubWorkItemsQueryTooLarge } from '../../../../shared/github/work-items-query-bounds'
import { parseTaskQuery, type ParsedTaskQuery } from '../../../../shared/task-query'
import {
  ghExecFileAsync,
  acquire,
  release,
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions,
  type OwnerRepo
} from '../../gh-utils'
import {
  githubHostExecOptions,
  resolveIssueGitHubApiRepositorySource,
  type GitHubRepoExecOptions
} from '../../github-api-repository'
import {
  getRateLimit,
  noteRepositoryRateLimitSpend,
  repositoryRateLimitGuard,
  spendsSharedGitHubComQuota
} from '../../rate-limit'
import { sameOwnerRepo } from './../github-exec-scope'
import { buildWorkItemListRequest, resolvePrWorkItemSource } from './work-item-list-request'
import { buildSearchQueryString, defaultOpenWorkItemQuery } from './work-item-search-query'
import { searchWorkItemCount, usesGraphqlWorkItemSearch } from './work-item-search-page'

function canGroupSearchText(text: string): boolean {
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (quoted) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        quoted = false
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === '\\') {
      return false
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth < 0) {
        return false
      }
    }
  }
  return depth === 0 && !quoted
}

export async function countWorkItemsForQuery(
  repoPath: string,
  ownerRepo: OwnerRepo,
  query: ParsedTaskQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<number> {
  const searchQ = buildSearchQueryString(ownerRepo, query)
  const ghOptions: GitHubRepoExecOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
  }
  if (usesGraphqlWorkItemSearch(ownerRepo, ghOptions)) {
    ghOptions.env = { ...process.env }
    try {
      if (query.scope === 'pr' && canGroupSearchText(query.freeText)) {
        const request = buildWorkItemListRequest({
          kind: 'pr',
          ownerRepo,
          query,
          limit: 1,
          page: 1
        })
        return await searchWorkItemCount(request.search, ghOptions, 'ISSUE_ADVANCED')
      }
      return await searchWorkItemCount(searchQ, ghOptions)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
    }
  }
  if (repositoryRateLimitGuard(ownerRepo, 'search', ghOptions).blocked) {
    return 0
  }
  const { stdout } = await ghExecFileAsync(
    [
      'api',
      '--cache',
      '120s',
      `search/issues?q=${encodeURIComponent(searchQ)}&per_page=1`,
      '--jq',
      '.total_count'
    ],
    ghOptions
  )
  // Overcount cached hits conservatively until the next budget probe.
  noteRepositoryRateLimitSpend(ownerRepo, 'search', 1, ghOptions)
  return Number.parseInt(stdout.trim(), 10) || 0
}

// Cache decorative totals to conserve the 30/minute search budget.
export async function countWorkItems(
  repoPath: string,
  query?: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<number> {
  const trimmedQuery = query?.trim() ?? ''
  if (isGitHubWorkItemsQueryTooLarge(trimmedQuery)) {
    return 0
  }
  const [issueResolved, prResolved] = await Promise.all([
    resolveIssueGitHubApiRepositorySource(repoPath, preference, connectionId, localGitOptions),
    resolvePrWorkItemSource(repoPath, preference, connectionId, localGitOptions)
  ])
  const issueOwnerRepo = issueResolved.source
  const prOwnerRepo = prResolved.source
  const ownerRepo = prOwnerRepo ?? issueOwnerRepo
  if (!ownerRepo) {
    return 0
  }

  const parsedQuery = trimmedQuery ? parseTaskQuery(trimmedQuery) : null
  const effectiveQuery = parsedQuery ?? defaultOpenWorkItemQuery()
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
  }

  // Decorative counts must stop at the search budget floor.
  if (spendsSharedGitHubComQuota(ownerRepo, ghOptions)) {
    await getRateLimit()
  }
  if (
    !usesGraphqlWorkItemSearch(ownerRepo, ghOptions) &&
    repositoryRateLimitGuard(ownerRepo, 'search', ghOptions).blocked
  ) {
    return 0
  }

  await acquire()
  try {
    if (sameOwnerRepo(issueOwnerRepo, prOwnerRepo)) {
      return await countWorkItemsForQuery(
        repoPath,
        ownerRepo,
        effectiveQuery,
        connectionId,
        localGitOptions
      )
    }

    const counts: Promise<number>[] = []
    // PR-only filters cannot match issues; avoid spending a search call on that half.
    const hasPrOnlyFilter =
      effectiveQuery.draft ||
      effectiveQuery.reviewRequested !== null ||
      effectiveQuery.reviewedBy !== null
    if (
      effectiveQuery.scope !== 'pr' &&
      effectiveQuery.state !== 'merged' &&
      !hasPrOnlyFilter &&
      issueOwnerRepo
    ) {
      counts.push(
        countWorkItemsForQuery(
          repoPath,
          issueOwnerRepo,
          { ...effectiveQuery, scope: 'issue' },
          connectionId,
          localGitOptions
        )
      )
    }
    if (effectiveQuery.scope !== 'issue' && prOwnerRepo) {
      counts.push(
        countWorkItemsForQuery(
          repoPath,
          prOwnerRepo,
          { ...effectiveQuery, scope: 'pr' },
          connectionId,
          localGitOptions
        )
      )
    }
    // Preserve counts from successful sources when another search fails.
    const results = await Promise.allSettled(counts)
    let total = 0
    for (const r of results) {
      if (r.status === 'fulfilled') {
        total += r.value
      } else {
        console.warn('countWorkItems partial failure:', r.reason)
      }
    }
    return total
  } catch (err) {
    console.warn('countWorkItems failed:', err)
    return 0
  } finally {
    release()
  }
}
