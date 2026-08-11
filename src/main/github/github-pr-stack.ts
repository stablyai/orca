import type {
  CheckStatus,
  GitHubPRStack,
  GitHubPRStackEntry,
  PRMergeableState,
  PRReviewDecision,
  PRState
} from '../../shared/types'
import { githubRepoIdentityKey } from '../../shared/github-repository-identity-key'
import { ghExecFileAsync } from '../git/runner'
import {
  githubHostExecOptions,
  type GitHubApiRepository,
  type GitHubRepoExecOptions
} from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const STACK_CACHE_TTL_MS = 30_000
const STACK_CACHE_MAX_ENTRIES = 256

type CachedStackDetails = {
  value: Omit<GitHubPRStack, 'position'> | null
  expiresAt: number
}

type GraphQLStackEntry = {
  position?: unknown
  pullRequest?: {
    number?: unknown
    title?: unknown
    url?: unknown
    updatedAt?: unknown
    state?: unknown
    isDraft?: unknown
    headRefName?: unknown
    headRefOid?: unknown
    mergeable?: unknown
    reviewDecision?: unknown
    mergeStateStatus?: unknown
    statusCheckRollup?: { state?: unknown } | null
  } | null
}

type GraphQLStackResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        stack?: {
          number?: unknown
          size?: unknown
          baseRefName?: unknown
          entries?: { nodes?: (GraphQLStackEntry | null)[] | null } | null
        } | null
      } | null
    } | null
  }
}

const stackDetailsCache = new Map<string, CachedStackDetails>()
const stackDetailsInFlight = new Map<string, Promise<Omit<GitHubPRStack, 'position'> | null>>()

export function _resetGitHubPRStackCacheForTests(): void {
  stackDetailsCache.clear()
  stackDetailsInFlight.clear()
}

function stackCacheKey(
  repository: GitHubApiRepository,
  stackNumber: number,
  executionScope: string
): string {
  return `${executionScope}\0${githubRepoIdentityKey(repository)}:${stackNumber}`
}

function pruneStackCache(now = Date.now()): void {
  for (const [key, cached] of stackDetailsCache) {
    if (cached.expiresAt <= now) {
      stackDetailsCache.delete(key)
    }
  }
  while (stackDetailsCache.size > STACK_CACHE_MAX_ENTRIES) {
    const oldestKey = stackDetailsCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    stackDetailsCache.delete(oldestKey)
  }
}

function mapStackPRState(value: unknown, isDraft: unknown): PRState {
  if (value === 'MERGED') {
    return 'merged'
  }
  if (value === 'CLOSED') {
    return 'closed'
  }
  return isDraft === true ? 'draft' : 'open'
}

function mapStackCheckStatus(value: unknown): CheckStatus {
  if (value === 'SUCCESS') {
    return 'success'
  }
  if (value === 'FAILURE' || value === 'ERROR') {
    return 'failure'
  }
  if (value === 'PENDING' || value === 'EXPECTED') {
    return 'pending'
  }
  return 'neutral'
}

function mapStackMergeable(value: unknown): PRMergeableState {
  return value === 'MERGEABLE' || value === 'CONFLICTING' ? value : 'UNKNOWN'
}

function mapReviewDecision(value: unknown): PRReviewDecision | null | undefined {
  if (value === null) {
    return null
  }
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value
  }
  return undefined
}

function mapStackEntry(entry: GraphQLStackEntry): GitHubPRStackEntry | null {
  const pr = entry.pullRequest
  if (
    typeof entry.position !== 'number' ||
    typeof pr?.number !== 'number' ||
    typeof pr.title !== 'string' ||
    typeof pr.url !== 'string'
  ) {
    return null
  }
  const reviewDecision = mapReviewDecision(pr.reviewDecision)
  return {
    position: entry.position,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    ...(typeof pr.updatedAt === 'string' ? { updatedAt: pr.updatedAt } : {}),
    state: mapStackPRState(pr.state, pr.isDraft),
    checksStatus: mapStackCheckStatus(pr.statusCheckRollup?.state),
    mergeable: mapStackMergeable(pr.mergeable),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(typeof pr.mergeStateStatus === 'string' ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(typeof pr.headRefName === 'string' ? { headRefName: pr.headRefName } : {}),
    ...(typeof pr.headRefOid === 'string' ? { headSha: pr.headRefOid } : {})
  }
}

function parseStackDetails(
  response: GraphQLStackResponse,
  expectedStackNumber: number,
  fallbackBaseRefName: string,
  fallbackSize: number
): Omit<GitHubPRStack, 'position'> | null {
  const stack = response.data?.repository?.pullRequest?.stack
  if (!stack || stack.number !== expectedStackNumber) {
    return null
  }
  const entries = (stack.entries?.nodes ?? [])
    .flatMap((entry) => (entry ? [mapStackEntry(entry)] : []))
    .filter((entry): entry is GitHubPRStackEntry => entry !== null)
    .sort((a, b) => a.position - b.position)
  return {
    number: expectedStackNumber,
    size: typeof stack.size === 'number' ? stack.size : fallbackSize,
    baseRefName: typeof stack.baseRefName === 'string' ? stack.baseRefName : fallbackBaseRefName,
    ...(entries.length > 0 ? { entries } : {})
  }
}

const STACK_DETAILS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      stack {
        number
        size
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest {
              number
              title
              url
              updatedAt
              state
              isDraft
              headRefName
              headRefOid
              mergeable
              reviewDecision
              mergeStateStatus
              statusCheckRollup { state }
            }
          }
        }
      }
    }
  }
}`

async function fetchStackDetails(
  repository: GitHubApiRepository,
  prNumber: number,
  summary: GitHubPRStack,
  ghOptions: GitHubRepoExecOptions
): Promise<Omit<GitHubPRStack, 'position'> | null> {
  if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
    return null
  }
  noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
  const { stdout } = await ghExecFileAsync(
    [
      'api',
      'graphql',
      '-f',
      `query=${STACK_DETAILS_QUERY}`,
      '-f',
      `owner=${repository.owner}`,
      '-f',
      `repo=${repository.repo}`,
      '-F',
      `pr=${prNumber}`
    ],
    { ...ghOptions, ...githubHostExecOptions(repository) }
  )
  return parseStackDetails(
    JSON.parse(stdout) as GraphQLStackResponse,
    summary.number,
    summary.baseRefName,
    summary.size
  )
}

export async function hydrateGitHubPRStack(
  repository: GitHubApiRepository,
  prNumber: number,
  summary: GitHubPRStack,
  ghOptions: GitHubRepoExecOptions,
  prUpdatedAt?: string,
  executionScope = 'local:host'
): Promise<GitHubPRStack> {
  const key = stackCacheKey(repository, summary.number, executionScope)
  const now = Date.now()
  pruneStackCache(now)
  const cached = stackDetailsCache.get(key)
  const cachedPRUpdatedAt = cached?.value?.entries?.find(
    (entry) => entry.number === prNumber
  )?.updatedAt
  const cachedMatchesPR = !prUpdatedAt || !cachedPRUpdatedAt || cachedPRUpdatedAt === prUpdatedAt
  if (cached && cached.expiresAt > now && cachedMatchesPR) {
    return cached.value
      ? { ...cached.value, position: summary.position, baseSha: summary.baseSha }
      : summary
  }
  const existing = stackDetailsInFlight.get(key)
  if (existing) {
    const value = await existing
    return value ? { ...value, position: summary.position, baseSha: summary.baseSha } : summary
  }
  const request = fetchStackDetails(repository, prNumber, summary, ghOptions).catch(() => null)
  stackDetailsInFlight.set(key, request)
  try {
    const value = await request
    stackDetailsCache.delete(key)
    stackDetailsCache.set(key, { value, expiresAt: Date.now() + STACK_CACHE_TTL_MS })
    pruneStackCache()
    return value ? { ...value, position: summary.position, baseSha: summary.baseSha } : summary
  } finally {
    if (stackDetailsInFlight.get(key) === request) {
      stackDetailsInFlight.delete(key)
    }
  }
}

export { mergeGitHubPRStack } from './github-pr-stack-async-merge'
