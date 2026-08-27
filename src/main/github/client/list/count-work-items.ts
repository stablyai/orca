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
  resolveIssueGitHubApiRepositorySource
} from '../../github-api-repository'
import {
  getRateLimit,
  noteRepositoryRateLimitSpend,
  repositoryRateLimitGuard,
  spendsSharedGitHubComQuota
} from '../../rate-limit'
import { sameOwnerRepo } from './../github-exec-scope'
import { resolvePrWorkItemSource } from './work-item-list-request'
import { buildSearchQueryString, defaultOpenWorkItemQuery } from './work-item-search-query'
export async function countWorkItemsForQuery(
  repoPath: string,
  ownerRepo: OwnerRepo,
  query: ParsedTaskQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<number> {
  const searchQ = buildSearchQueryString(ownerRepo, query)
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
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
  // Why: over-counting cache hits is the safe direction — the next probe corrects the estimate.
  noteRepositoryRateLimitSpend(ownerRepo, 'search', 1, ghOptions)
  return Number.parseInt(stdout.trim(), 10) || 0
}

// Why: cached 120s to avoid burning the 30/min search rate limit that backs the pagination total.
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

  // Why: counts are decorative, so stop when the 30/min search budget is gone rather than spawn into 403s (getRateLimit is 30s-cached).
  if (spendsSharedGitHubComQuota(ownerRepo, ghOptions)) {
    await getRateLimit()
  }
  if (repositoryRateLimitGuard(ownerRepo, 'search', ghOptions).blocked) {
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
    // Why: draft/reviewRequested/reviewedBy are PR-only, so the issue half would always return 0 — skip it to save a search call.
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
    // Why: allSettled so one failing search side doesn't zero the total; sum only fulfilled halves.
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
