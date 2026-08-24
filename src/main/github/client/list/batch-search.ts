import type { ClassifiedError } from '../../../../shared/classified-error'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import {
  ghExecFileAsync,
  ghRepoExecOptions,
  githubRepoContext,
  acquire,
  release
} from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { WorkItemSearchScope } from '../../work-item-search-query'
import type {
  GitHubWorkItemsBatchInput,
  GitHubWorkItemResolutionFailure
} from './work-items-across-repos'

export type ResolvedBatchRepo = GitHubWorkItemsBatchInput & {
  issueSource: GitHubApiRepository | null
  issueSourceFellBack: boolean
  prSource: GitHubApiRepository | null
  originCandidate: GitHubApiRepository | null
  upstreamCandidate: GitHubApiRepository | null
  resolutionFailures: GitHubWorkItemResolutionFailure[]
}

export type BatchSourceMember = {
  source: GitHubApiRepository
  repo: ResolvedBatchRepo
}

export type BatchSearchGroup = {
  key: string
  anchor: ResolvedBatchRepo
  issueSources: Map<string, BatchSourceMember>
  prSources: Map<string, BatchSourceMember>
}

export type BatchSearchPlan = {
  group: BatchSearchGroup
  scope: WorkItemSearchScope
  sources: Map<string, BatchSourceMember>
}

export type BatchSearchOutcome = {
  items: GitHubWorkItem[]
  totalCount: number
  reachableCount: number
  failedCount: number
  unavailableCount: number
  errorTypes: ClassifiedError['type'][]
  hasSuccessfulRequest: boolean
  searchWindowLimited: boolean
  queryTooLarge: boolean
}

export function batchExecutionKey(
  input: GitHubWorkItemsBatchInput,
  source: GitHubApiRepository
): string {
  return [
    input.connectionId ?? 'local',
    input.localGitOptions?.wslDistro ?? '',
    source.host?.trim().toLowerCase() || 'github.com'
  ].join('\0')
}

export function addBatchSource(
  group: BatchSearchGroup,
  kind: 'issue' | 'pr',
  source: GitHubApiRepository,
  repo: ResolvedBatchRepo
): void {
  const target = kind === 'issue' ? group.issueSources : group.prSources
  const key = githubRepoIdentityKey(source)
  // Why: selecting the same GitHub remote twice cannot be represented by one
  // Search API total_count. Keep first source mapping so page/count remain an
  // exact set rather than inventing a multiplied count.
  if (!target.has(key)) {
    target.set(key, { source, repo })
  }
}

export function batchItemComparator(left: GitHubWorkItem, right: GitHubWorkItem): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(rightTime) ? 1 : -1
  }
  const leftKey = `${left.repoId}\0${left.type}\0${left.number}`
  const rightKey = `${right.repoId}\0${right.type}\0${right.number}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

function batchHasPrOnlyFilter(query: ParsedTaskQuery): boolean {
  return (
    query.state === 'merged' ||
    query.draft ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
  )
}

function sameSourceKeys(
  left: Map<string, BatchSourceMember>,
  right: Map<string, BatchSourceMember>
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const key of left.keys()) {
    if (!right.has(key)) {
      return false
    }
  }
  return true
}

export function batchSearchPlans(
  groups: readonly BatchSearchGroup[],
  query: ParsedTaskQuery
): BatchSearchPlan[] {
  const plans: BatchSearchPlan[] = []
  const issueAllowed =
    query.scope !== 'pr' && query.state !== 'merged' && !batchHasPrOnlyFilter(query)
  const prAllowed = query.scope !== 'issue'
  for (const group of groups) {
    if (issueAllowed && prAllowed && sameSourceKeys(group.issueSources, group.prSources)) {
      plans.push({ group, scope: 'all', sources: group.issueSources })
      continue
    }
    if (issueAllowed && group.issueSources.size > 0) {
      plans.push({ group, scope: 'issue', sources: group.issueSources })
    }
    if (prAllowed && group.prSources.size > 0) {
      plans.push({ group, scope: 'pr', sources: group.prSources })
    }
  }
  return plans
}

export async function fetchSearchResponse(
  group: BatchSearchGroup,
  query: string,
  page: number,
  perPage: number,
  noCache: boolean
): Promise<{ items: Record<string, unknown>[]; totalCount: number }> {
  const source = [...group.issueSources.values(), ...group.prSources.values()][0]?.source
  if (!source) {
    return { items: [], totalCount: 0 }
  }
  const args = [
    'api',
    ...(noCache ? [] : ['--cache', '120s']),
    `search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=${perPage}&page=${page}`,
    '--jq',
    '{items: .items, totalCount: .total_count}'
  ]
  const ghOptions = {
    ...ghRepoExecOptions(
      githubRepoContext(
        group.anchor.repoPath,
        group.anchor.connectionId,
        group.anchor.localGitOptions
      )
    ),
    ...githubHostExecOptions(source)
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(args, ghOptions)
    // Why: grouped requests still consume Search API budget; count cached hits
    // conservatively so the shared guard does not let a multi-repo selection
    // stampede the 30/minute quota.
    noteRepositoryRateLimitSpend(source, 'search', 1, ghOptions)
    const parsed = JSON.parse(stdout) as {
      items?: unknown
      totalCount?: unknown
    }
    return {
      items: Array.isArray(parsed.items)
        ? parsed.items.filter(
            (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
          )
        : [],
      totalCount: typeof parsed.totalCount === 'number' ? parsed.totalCount : 0
    }
  } finally {
    release()
  }
}

export function mergeBatchSearchOutcomes(
  outcomes: BatchSearchOutcome[],
  resolutionErrorTypes: ClassifiedError[]
): {
  totalCount: number
  reachableCount: number
  failedCount: number
  unavailableCount: number
  errorTypes: ClassifiedError['type'][]
  hasSuccessfulRequest: boolean
  searchWindowLimited: boolean
  queryTooLarge: boolean
} {
  const totalCount = outcomes.reduce((sum, outcome) => sum + outcome.totalCount, 0)
  const reachableCount = outcomes.reduce((sum, outcome) => sum + outcome.reachableCount, 0)
  let failedCount = outcomes.reduce((sum, outcome) => sum + outcome.failedCount, 0)
  const unavailableCount = outcomes.reduce((sum, outcome) => sum + outcome.unavailableCount, 0)
  const errorTypes = [
    ...resolutionErrorTypes.map((error) => error.type),
    ...outcomes.flatMap((outcome) => outcome.errorTypes)
  ]
  return {
    totalCount,
    reachableCount,
    failedCount,
    unavailableCount,
    errorTypes,
    hasSuccessfulRequest: outcomes.some((outcome) => outcome.hasSuccessfulRequest),
    searchWindowLimited: outcomes.some((outcome) => outcome.searchWindowLimited),
    queryTooLarge: outcomes.some((outcome) => outcome.queryTooLarge)
  }
}
