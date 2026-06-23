/* eslint-disable max-lines -- Why: co-locating all GitHub client functions keeps the
concurrency acquire/release pattern and error handling consistent across operations. */
import type {
  ClassifiedError,
  GitPushTarget,
  IssueSourcePreference,
  ListWorkItemsResult,
  PRInfo,
  PRConflictSummary,
  PRRefreshOutcome,
  PRMergeableState,
  PRReviewDecision,
  PRCheckDetail,
  PRCheckRunDetails,
  GitHubCommentResult,
  GitHubPRReviewCommentInput,
  PRComment,
  GitHubViewer,
  GitHubWorkItem,
  GitHubPullRequestStateUpdate,
  GitHubRerunPRChecksResult,
  GitHubPRMergeMethod,
  GitHubPRMergeMethodSettings
} from '../../shared/types'
import type { CreateHostedReviewInput, CreateHostedReviewResult } from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { normalizeGitHubPRMergeMethodSettings } from '../../shared/github-pr-merge-methods'
import { isGitHubWorkItemsQueryTooLarge } from '../../shared/github-work-items-query-bounds'
import { parseTaskQuery, type ParsedTaskQuery } from '../../shared/task-query'
import {
  GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE,
  sortWorkItemsByUpdatedAt
} from '../../shared/work-items'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getPRConflictSummary } from './conflict-summary'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import { splitRemoteBranchName } from '../../shared/git-effective-upstream'
import {
  execFileAsync,
  ghExecFileAsync,
  gitExecFileAsync,
  extractExecError,
  acquire,
  release,
  getOwnerRepo,
  getIssueOwnerRepo,
  getOwnerRepoForRemote,
  resolvePRRepositoryCandidates,
  resolveIssueSource,
  classifyGhError,
  classifyListIssuesError,
  ghRepoExecOptions,
  githubRepoContext,
  getRemoteUrlForRepo,
  type LocalGitExecOptions,
  type OwnerRepo
} from './gh-utils'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
export { _resetOwnerRepoCache } from './gh-utils'
export {
  getIssue,
  listIssues,
  createIssue,
  updateIssue,
  addIssueComment,
  listLabels,
  listAssignableUsers
} from './issues'
import {
  mapCheckRunRESTStatus,
  mapCheckRunRESTConclusion,
  mapCheckStatus,
  mapCheckConclusion,
  mapPRState,
  deriveCheckStatus
} from './mappers'
import { mapGraphQLReactionGroups, type GitHubGraphQLReactionGroup } from './comment-reactions'
import {
  getRateLimit,
  noteRateLimitSpend,
  rateLimitGuard,
  type RateLimitBucketKind
} from './rate-limit'

type GhExecOptions = ReturnType<typeof ghRepoExecOptions>
type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

const ORCA_REPO = 'stablyai/orca'
const PR_CHECK_LOG_TAIL_LINES = 200
const PR_CHECK_LOG_TAIL_BYTES = 16 * 1024
const PR_CHECK_LOG_TAIL_JOB_LIMIT = 5
// Why: each entry holds up to 16KB of log text; bound the cache so a long
// session reviewing many failing checks can't grow it without limit.
const PR_CHECK_LOG_TAIL_CACHE_MAX_ENTRIES = 128
const prCheckLogTailCache = new Map<string, string | null>()

function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [getHostedReviewLocalGitOptions(options)] : []
}

function setPrCheckLogTailCache(cacheKey: string, logTail: string | null): void {
  prCheckLogTailCache.set(cacheKey, logTail)
  while (prCheckLogTailCache.size > PR_CHECK_LOG_TAIL_CACHE_MAX_ENTRIES) {
    const oldestKey = prCheckLogTailCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    prCheckLogTailCache.delete(oldestKey)
  }
}
const MERGE_QUEUE_CACHE_TTL_MS = 10 * 60 * 1000
const MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS = 60 * 1000
const MERGE_QUEUE_CACHE_MAX_ENTRIES = 256
type GitHubRepositoryMergeMetadata = {
  mergeQueueRequired: boolean | null
  autoMergeAllowed: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
}
const repositoryMergeMetadataCache = new Map<
  string,
  { value: GitHubRepositoryMergeMetadata; expiresAt: number }
>()

export function _resetMergeQueueCacheForTests(): void {
  repositoryMergeMetadataCache.clear()
}

export function _getMergeQueueCacheSizeForTests(): number {
  return repositoryMergeMetadataCache.size
}

function pruneRepositoryMergeMetadataCache(now = Date.now()): void {
  for (const [cacheKey, cached] of repositoryMergeMetadataCache) {
    if (cached.expiresAt <= now) {
      repositoryMergeMetadataCache.delete(cacheKey)
    }
  }
  while (repositoryMergeMetadataCache.size > MERGE_QUEUE_CACHE_MAX_ENTRIES) {
    const oldestKey = repositoryMergeMetadataCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    repositoryMergeMetadataCache.delete(oldestKey)
  }
}

async function assertRateLimitBudget(bucket: RateLimitBucketKind): Promise<void> {
  await getRateLimit()
  const guard = rateLimitGuard(bucket)
  if (guard.blocked) {
    throw new Error(
      `GitHub ${bucket} rate limit is low; retry after ${new Date(guard.resetAt * 1000).toLocaleTimeString()}`
    )
  }
}

function classifyPRRefreshError(
  err: unknown
): Extract<PRRefreshOutcome, { kind: 'upstream-error' }>['errorType'] {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (lower.includes('rate limit')) {
    return 'rate_limited'
  }
  if (
    lower.includes('timeout') ||
    lower.includes('no such host') ||
    lower.includes('network') ||
    lower.includes('could not resolve host')
  ) {
    return 'network'
  }
  if (lower.includes('http 403') || lower.includes('resource not accessible')) {
    return 'permission'
  }
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  return /auth|login|credential/i.test(message) ? 'auth' : 'unknown'
}

function safePRRefreshErrorMessage(
  errorType: Extract<PRRefreshOutcome, { kind: 'upstream-error' }>['errorType']
): string {
  switch (errorType) {
    case 'rate_limited':
      return 'GitHub rate limit is low. Try again after the limit resets.'
    case 'auth':
      return 'GitHub authentication is unavailable. Check your gh login.'
    case 'network':
      return 'GitHub is unreachable right now. Check your network and try again.'
    case 'permission':
      return 'GitHub did not allow access to this pull request.'
    case 'repo_unavailable':
      return 'The GitHub repository is unavailable or cannot be resolved.'
    case 'gh_unavailable':
      return 'GitHub CLI is unavailable.'
    case 'unknown':
      return 'GitHub pull request refresh failed.'
  }
}

function prRefreshUpstreamError(
  err: unknown
): Extract<PRRefreshOutcome, { kind: 'upstream-error' }> {
  const errorType = classifyPRRefreshError(err)
  return {
    kind: 'upstream-error',
    errorType,
    message: safePRRefreshErrorMessage(errorType),
    fetchedAt: Date.now()
  }
}

function isNoPullRequestError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no pull requests? found|could not find.*pull request/i.test(message)
}

/**
 * Check if the authenticated user has starred the Orca repo.
 * Returns true if starred, false if not, null if unable to determine (gh unavailable).
 */
export async function checkOrcaStarred(): Promise<boolean | null> {
  await acquire()
  try {
    const { stdout, stderr } = await execFileAsync(
      'gh',
      ['api', '--include', `user/starred/${ORCA_REPO}`],
      { encoding: 'utf-8' }
    )
    const response = `${stdout ?? ''}\n${stderr ?? ''}`
    if (/HTTP\/\S+\s+(?:200|204)\b/.test(response)) {
      return true
    }
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 404 means the user hasn't starred — the only expected "no" answer
    if (message.includes('HTTP 404')) {
      return false
    }
    // Anything else (gh not installed, not authenticated, network issue)
    return null
  } finally {
    release()
  }
}

function pickPushRemoteUrl(args: {
  originUrl: string | null
  cloneUrl: string
  sshUrl: string
}): string {
  const { originUrl, cloneUrl, sshUrl } = args
  if (originUrl && (/^(git@|ssh:)/.test(originUrl) || originUrl.includes('ssh.github.com'))) {
    return sshUrl
  }
  return cloneUrl
}

function sanitizeRemoteName(owner: string, repo: string): string {
  const slug = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug ? `pr-${slug}` : 'pr-head'
}

/**
 * A fork push target plus the PR's `maintainer_can_modify` flag. The flag rides
 * alongside the target (rather than inside {@link GitPushTarget}) so it never
 * leaks into the persisted, validated push-target shape.
 */
export type PullRequestPushTarget = {
  pushTarget: GitPushTarget
  /** false when the PR has "Allow edits from maintainers" off; a push may be rejected. */
  maintainerCanModify?: boolean
}

export async function getPullRequestPushTarget(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PullRequestPushTarget | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)
  const { candidates } = await resolvePRRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions
  )
  if (candidates.length === 0) {
    return null
  }

  await acquire()
  try {
    let prStdout = ''
    for (const candidate of candidates) {
      try {
        const { stdout } = await ghExecFileAsync(
          ['api', `repos/${candidate.owner}/${candidate.repo}/pulls/${prNumber}`],
          {
            ...ghOptions
          }
        )
        prStdout = stdout
        break
      } catch (error) {
        // Why: in fork workflows `origin` is often the contributor fork while
        // the PR number belongs to `upstream`; probe all known PR repos before
        // deciding this PR number is unavailable.
        if (isNotFoundGhError(error)) {
          continue
        }
        throw error
      }
    }
    if (!prStdout) {
      return null
    }
    const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
    const pr = JSON.parse(prStdout) as {
      maintainer_can_modify?: boolean
      head?: {
        ref?: string
        repo?: {
          full_name?: string
          clone_url?: string
          ssh_url?: string
          owner?: { login?: string }
          name?: string
        } | null
      }
    }
    const headRepo = pr.head?.repo
    const branchName = pr.head?.ref?.trim()
    const owner = headRepo?.owner?.login?.trim()
    const repo = headRepo?.name?.trim() ?? headRepo?.full_name?.split('/')[1]?.trim()
    const cloneUrl = headRepo?.clone_url?.trim()
    const sshUrl = headRepo?.ssh_url?.trim()
    const maintainerCanModify =
      typeof pr.maintainer_can_modify === 'boolean' ? pr.maintainer_can_modify : undefined
    if (!owner || !repo || !branchName || !cloneUrl || !sshUrl) {
      return null
    }
    if (
      origin &&
      origin.owner.toLowerCase() === owner.toLowerCase() &&
      origin.repo.toLowerCase() === repo.toLowerCase()
    ) {
      return {
        pushTarget: { remoteName: 'origin', branchName },
        ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
      }
    }

    let originUrl: string | null = null
    try {
      const rawOriginUrl = await getRemoteUrlForRepo(context, 'origin')
      originUrl = rawOriginUrl?.trim() || null
    } catch {
      originUrl = null
    }
    return {
      pushTarget: {
        remoteName: sanitizeRemoteName(owner, repo),
        branchName,
        remoteUrl: pickPushRemoteUrl({ originUrl, cloneUrl, sshUrl })
      },
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  } finally {
    release()
  }
}

/**
 * Star the Orca repo for the authenticated user.
 */
export async function starOrca(): Promise<boolean> {
  await acquire()
  try {
    await execFileAsync('gh', ['api', '-X', 'PUT', `user/starred/${ORCA_REPO}`], {
      encoding: 'utf-8'
    })
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

/**
 * Get the authenticated GitHub viewer when gh is available and logged in.
 * Returns null when gh is unavailable, unauthenticated, or the lookup fails.
 */
export async function getAuthenticatedViewer(): Promise<GitHubViewer | null> {
  await acquire()
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', 'user', '--jq', '{login: .login, email: .email}'],
      { encoding: 'utf-8' }
    )
    const viewer = JSON.parse(stdout) as { login?: string; email?: string | null }
    if (!viewer.login?.trim()) {
      return null
    }
    return {
      login: viewer.login.trim(),
      email: viewer.email?.trim() || null
    }
  } catch {
    return null
  } finally {
    release()
  }
}

// Why: main-process maps omit repoId because the IPC handler never receives
// a repo identifier beyond path. The renderer stamps repoId after IPC so
// single-repo and cross-repo items are uniform downstream.
type MainWorkItem = Omit<GitHubWorkItem, 'repoId'>

const WORK_ITEM_ISSUE_LIST_JSON_FIELDS = 'number,title,state,url,labels,updatedAt,author,assignees'

const WORK_ITEM_PR_LIST_JSON_FIELDS =
  'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests'

// Why: these fields are intentionally excluded from `gh pr list` because
// statusCheckRollup/review decision/PR-specific merge metadata fan out into
// expensive GraphQL work across every row. Requested reviewers are kept in the
// list payload because the Tasks table renders that column on first paint.
const WORK_ITEM_PR_DETAIL_JSON_FIELDS =
  'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,additions,deletions,changedFiles,reviewDecision,reviewRequests,latestReviews,assignees,statusCheckRollup,mergeable,mergeStateStatus,autoMergeRequest,maintainerCanModify'

function mapIssueWorkItem(item: Record<string, unknown>): MainWorkItem {
  return {
    id: `issue:${String(item.number)}`,
    type: 'issue',
    number: Number(item.number),
    title: String(item.title ?? ''),
    state: String(item.state ?? 'open') === 'closed' ? 'closed' : 'open',
    url: String(item.html_url ?? item.url ?? ''),
    labels: Array.isArray(item.labels)
      ? item.labels
          .map((label) =>
            typeof label === 'object' && label !== null && 'name' in label
              ? String((label as { name?: unknown }).name ?? '')
              : ''
          )
          .filter(Boolean)
      : [],
    updatedAt: String(item.updated_at ?? item.updatedAt ?? ''),
    author:
      typeof item.user === 'object' && item.user !== null && 'login' in item.user
        ? String((item.user as { login?: unknown }).login ?? '')
        : typeof item.author === 'object' && item.author !== null && 'login' in item.author
          ? String((item.author as { login?: unknown }).login ?? '')
          : null,
    ...(item.assignees !== undefined ? { assignees: usersFromUnknown(item.assignees) } : {})
  }
}

function extractHeadOwnerLogin(item: Record<string, unknown>): string | null {
  // gh CLI `pr list --json headRepositoryOwner` shape: { login }
  if (typeof item.headRepositoryOwner === 'object' && item.headRepositoryOwner !== null) {
    const login = (item.headRepositoryOwner as { login?: unknown }).login
    if (typeof login === 'string' && login.trim()) {
      return login
    }
  }
  // REST API `pull_request` shape: head.repo.owner.login
  if (typeof item.head === 'object' && item.head !== null) {
    const head = item.head as { repo?: unknown; user?: unknown; label?: unknown }
    const repo = head.repo
    if (typeof repo === 'object' && repo !== null) {
      const owner = (repo as { owner?: unknown }).owner
      if (typeof owner === 'object' && owner !== null) {
        const login = (owner as { login?: unknown }).login
        if (typeof login === 'string' && login.trim()) {
          return login
        }
      }
    }
    // Why: when a fork is deleted or made inaccessible, GitHub can return
    // `head.repo = null` but still include `head.user`/`head.label`.
    const user = head.user
    if (typeof user === 'object' && user !== null) {
      const login = (user as { login?: unknown }).login
      if (typeof login === 'string' && login.trim()) {
        return login
      }
    }
    if (typeof head.label === 'string') {
      const owner = head.label.split(':', 1)[0]?.trim()
      if (owner) {
        return owner
      }
    }
  }
  return null
}

function userFromUnknown(
  value: unknown
): { login: string; name: string | null; avatarUrl: string } | null {
  if (typeof value === 'string') {
    const login = value.trim()
    return login ? { login, name: null, avatarUrl: '' } : null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Record<string, unknown>
  const login = typeof raw.login === 'string' ? raw.login.trim() : ''
  if (!login) {
    return null
  }
  const databaseId = numberFromUnknown(raw.databaseId)
  return {
    login,
    name: typeof raw.name === 'string' ? raw.name : null,
    avatarUrl:
      typeof raw.avatarUrl === 'string'
        ? raw.avatarUrl
        : typeof raw.avatar_url === 'string'
          ? raw.avatar_url
          : databaseId !== undefined
            ? `https://avatars.githubusercontent.com/u/${databaseId}?v=4`
            : ''
  }
}

function usersFromUnknown(
  value: unknown
): { login: string; name: string | null; avatarUrl: string }[] {
  if (!Array.isArray(value)) {
    return []
  }
  const users: { login: string; name: string | null; avatarUrl: string }[] = []
  for (const entry of value) {
    const direct = userFromUnknown(entry)
    if (direct) {
      users.push(direct)
      continue
    }
    if (typeof entry === 'object' && entry !== null) {
      const raw = entry as Record<string, unknown>
      const nested = userFromUnknown(raw.requestedReviewer ?? raw.user ?? raw.author)
      if (nested) {
        users.push(nested)
      }
    }
  }
  return users
}

function latestReviewsFromUnknown(value: unknown): NonNullable<GitHubWorkItem['latestReviews']> {
  if (!Array.isArray(value)) {
    return []
  }
  const reviews: NonNullable<GitHubWorkItem['latestReviews']> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const raw = entry as Record<string, unknown>
    const author = userFromUnknown(raw.author)
    if (!author) {
      continue
    }
    reviews.push({
      login: author.login,
      state: typeof raw.state === 'string' ? raw.state : null,
      avatarUrl: author.avatarUrl
    })
  }
  return reviews
}

function numberFromUnknown(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function normalizePRMergeable(value: unknown): PRMergeableState | undefined {
  const raw = typeof value === 'string' ? value.toUpperCase() : ''
  if (raw === 'MERGEABLE' || raw === 'CONFLICTING' || raw === 'UNKNOWN') {
    return raw
  }
  if (typeof value === 'boolean') {
    return value ? 'MERGEABLE' : 'CONFLICTING'
  }
  return undefined
}

function normalizeReviewDecision(value: unknown): PRReviewDecision | null {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : null
}

function isAutoMergeEnabled(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function checkRollupEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const raw = value as Record<string, unknown>
  const nodes = (raw.contexts as { nodes?: unknown } | undefined)?.nodes
  return Array.isArray(nodes) ? nodes : []
}

function deriveWorkItemCheckSummary(value: unknown): GitHubWorkItem['checksSummary'] {
  const entries = checkRollupEntries(value)
  if (entries.length === 0) {
    return { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 }
  }
  let passed = 0
  let failed = 0
  let pending = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      pending += 1
      continue
    }
    const raw = entry as Record<string, unknown>
    const conclusion = String(raw.conclusion ?? raw.state ?? '').toUpperCase()
    const status = String(raw.status ?? '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
      passed += 1
    } else if (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
        conclusion
      )
    ) {
      failed += 1
    } else if (status === 'COMPLETED' && conclusion) {
      failed += 1
    } else {
      pending += 1
    }
  }
  return {
    state: failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success',
    total: entries.length,
    passed,
    failed,
    pending
  }
}

function mapPullRequestWorkItem(
  item: Record<string, unknown>,
  baseOwnerRepo: OwnerRepo | null = null
): MainWorkItem {
  // Why: fork PRs are disabled in the Start-from picker. We compare the PR head's
  // owner to the selected repo's owner; when the base repo is unknown we default
  // to false so non-picker call sites see the same shape as before.
  const headOwnerLogin = extractHeadOwnerLogin(item)
  // Why: only emit isCrossRepository when we actually know the head owner. If
  // the gh response lacks `headRepositoryOwner` (older callers, tests without
  // that fixture, or gh not returning it), leave the field undefined instead
  // of falsely claiming "not a fork".
  const isCrossRepository =
    headOwnerLogin !== null && baseOwnerRepo !== null
      ? headOwnerLogin !== baseOwnerRepo.owner
      : null
  const state = String(item.state ?? '').toLowerCase()
  const additions = numberFromUnknown(item.additions)
  const deletions = numberFromUnknown(item.deletions)
  const changedFiles = numberFromUnknown(
    item.changedFiles ??
      item.changed_files ??
      (item.files as { totalCount?: unknown } | undefined)?.totalCount
  )
  const mergeable = normalizePRMergeable(item.mergeable)
  const headSha =
    typeof item.headRefOid === 'string'
      ? item.headRefOid
      : typeof item.head === 'object' && item.head !== null
        ? typeof (item.head as { sha?: unknown }).sha === 'string'
          ? (item.head as { sha: string }).sha
          : undefined
        : undefined
  return {
    id: `pr:${String(item.number)}`,
    type: 'pr',
    number: Number(item.number),
    title: String(item.title ?? ''),
    state:
      state === 'merged' || item.merged_at || item.mergedAt
        ? 'merged'
        : state === 'closed'
          ? 'closed'
          : item.isDraft || item.draft
            ? 'draft'
            : 'open',
    url: String(item.html_url ?? item.url ?? ''),
    labels: Array.isArray(item.labels)
      ? item.labels
          .map((label) =>
            typeof label === 'object' && label !== null && 'name' in label
              ? String((label as { name?: unknown }).name ?? '')
              : ''
          )
          .filter(Boolean)
      : [],
    updatedAt: String(item.updated_at ?? item.updatedAt ?? ''),
    author:
      typeof item.user === 'object' && item.user !== null && 'login' in item.user
        ? String((item.user as { login?: unknown }).login ?? '')
        : typeof item.author === 'object' && item.author !== null && 'login' in item.author
          ? String((item.author as { login?: unknown }).login ?? '')
          : null,
    branchName:
      typeof item.head === 'object' && item.head !== null && 'ref' in item.head
        ? String((item.head as { ref?: unknown }).ref ?? '')
        : String(item.headRefName ?? ''),
    baseRefName:
      typeof item.base === 'object' && item.base !== null && 'ref' in item.base
        ? String((item.base as { ref?: unknown }).ref ?? '')
        : String(item.baseRefName ?? ''),
    ...(headSha ? { headSha } : {}),
    ...(baseOwnerRepo ? { prRepo: { owner: baseOwnerRepo.owner, repo: baseOwnerRepo.repo } } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    ...('reviewDecision' in item
      ? { reviewDecision: normalizeReviewDecision(item.reviewDecision) }
      : {}),
    ...(item.reviewRequests !== undefined || item.requested_reviewers !== undefined
      ? { reviewRequests: usersFromUnknown(item.reviewRequests ?? item.requested_reviewers) }
      : {}),
    ...(item.latestReviews !== undefined
      ? { latestReviews: latestReviewsFromUnknown(item.latestReviews) }
      : {}),
    ...(item.assignees !== undefined ? { assignees: usersFromUnknown(item.assignees) } : {}),
    ...(item.statusCheckRollup !== undefined
      ? { checksSummary: deriveWorkItemCheckSummary(item.statusCheckRollup) }
      : {}),
    ...(mergeable ? { mergeable } : {}),
    ...('autoMergeRequest' in item
      ? { autoMergeEnabled: isAutoMergeEnabled(item.autoMergeRequest) }
      : {}),
    ...('mergeStateStatus' in item
      ? {
          mergeStateStatus: typeof item.mergeStateStatus === 'string' ? item.mergeStateStatus : null
        }
      : {}),
    ...(typeof item.maintainerCanModify === 'boolean'
      ? { maintainerCanModify: item.maintainerCanModify }
      : {}),
    ...(isCrossRepository !== null ? { isCrossRepository } : {})
  }
}

async function hydrateWorkItemRepositoryMergeMetadata(
  items: MainWorkItem[],
  ownerRepo: OwnerRepo | null,
  ghOptions: GhExecOptions
): Promise<MainWorkItem[]> {
  const hasPullRequest = items.some((item) => item.type === 'pr')
  if (!ownerRepo || !hasPullRequest) {
    return items
  }
  // Why: merge method settings are repository-level, so one cached metadata
  // probe can keep Tasks rows accurate without per-PR GraphQL fan-out.
  const mergeMetadata = await detectRepositoryMergeMetadata(ownerRepo, undefined, ghOptions)
  if (!mergeMetadata.mergeMethodSettings && mergeMetadata.autoMergeAllowed === null) {
    return items
  }
  return items.map((item) =>
    item.type === 'pr'
      ? {
          ...item,
          ...(mergeMetadata.autoMergeAllowed !== null
            ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed }
            : {}),
          ...(mergeMetadata.mergeMethodSettings
            ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
            : {})
        }
      : item
  )
}

async function fetchIssueWorkItem(
  repoPath: string,
  ownerRepo: OwnerRepo | null,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  if (ownerRepo) {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${number}`],
      ghOptions
    )
    const item = JSON.parse(stdout) as Record<string, unknown>
    if ('pull_request' in item) {
      return null
    }
    return mapIssueWorkItem(item)
  }

  const { stdout } = await ghExecFileAsync(
    ['issue', 'view', String(number), '--json', 'number,title,state,url,labels,updatedAt,author'],
    ghOptions
  )
  return mapIssueWorkItem(JSON.parse(stdout) as Record<string, unknown>)
}

async function fetchPullRequestWorkItem(
  repoPath: string,
  ownerRepo: OwnerRepo | null,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  if (ownerRepo) {
    try {
      const { stdout } = await ghExecFileAsync(
        [
          'pr',
          'view',
          String(number),
          '--repo',
          `${ownerRepo.owner}/${ownerRepo.repo}`,
          '--json',
          WORK_ITEM_PR_DETAIL_JSON_FIELDS
        ],
        ghOptions
      )
      const item = JSON.parse(stdout) as Record<string, unknown>
      const mapped = mapPullRequestWorkItem(item, ownerRepo)
      const baseRefName = typeof item.baseRefName === 'string' ? item.baseRefName : undefined
      const mergeMetadata = await detectRepositoryMergeMetadata(ownerRepo, baseRefName, ghOptions)
      return {
        ...mapped,
        mergeQueueRequired: mergeMetadata.mergeQueueRequired,
        ...(mergeMetadata.autoMergeAllowed !== null
          ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed }
          : {}),
        ...(mergeMetadata.mergeMethodSettings
          ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
          : {})
      }
    } catch {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
        ghOptions
      )
      return mapPullRequestWorkItem(JSON.parse(stdout) as Record<string, unknown>, ownerRepo)
    }
  }

  const { stdout } = await ghExecFileAsync(
    ['pr', 'view', String(number), '--json', WORK_ITEM_PR_DETAIL_JSON_FIELDS],
    ghOptions
  )
  return mapPullRequestWorkItem(JSON.parse(stdout) as Record<string, unknown>)
}

function buildWorkItemListArgs(args: {
  kind: 'issue' | 'pr'
  ownerRepo: OwnerRepo | null
  limit: number
  query: ParsedTaskQuery
  before?: string
}): string[] {
  const { kind, ownerRepo, limit, query, before } = args
  const fields = kind === 'issue' ? WORK_ITEM_ISSUE_LIST_JSON_FIELDS : WORK_ITEM_PR_LIST_JSON_FIELDS
  const command = kind === 'issue' ? ['issue', 'list'] : ['pr', 'list']
  const out = [...command, '--limit', String(limit), '--json', fields]

  if (ownerRepo) {
    out.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
  }

  if (query.state) {
    out.push('--state', query.state)
  }
  // Why: GitHub considers merged PRs as "closed". When the user filters for
  // closed-only, exclude merged PRs via the search predicate so the displayed
  // and counted results match the user's intent.
  const excludeMergedFromClosed = kind === 'pr' && query.state === 'closed'

  if (query.assignee) {
    out.push('--assignee', query.assignee)
  }
  if (query.author) {
    out.push('--author', query.author)
  }
  if (query.labels.length > 0) {
    for (const label of query.labels) {
      out.push('--label', label)
    }
  }
  // Why: only add --draft when the user explicitly typed `is:draft`. Previously
  // this fired for any PR-scoped open query, which made `is:pr is:open` (the
  // "PRs" preset) silently filter to drafts-only.
  if (kind === 'pr' && query.draft) {
    out.push('--draft')
  }

  const searchParts: string[] = []
  if (excludeMergedFromClosed) {
    searchParts.push('-is:merged')
  }
  // Why: cursor-based pagination. GitHub search supports updated:<DATE to
  // fetch items older than the cursor. We use the oldest item's updatedAt
  // from the previous page as the cursor.
  if (before) {
    searchParts.push(`updated:<${before}`)
  }
  if (kind === 'pr' && query.reviewRequested) {
    searchParts.push(`review-requested:${query.reviewRequested}`)
  }
  if (kind === 'pr' && query.reviewedBy) {
    searchParts.push(`reviewed-by:${query.reviewedBy}`)
  }
  if (query.freeText) {
    searchParts.push(query.freeText)
  }
  if (searchParts.length > 0) {
    out.push('--search', searchParts.join(' '))
  }
  return out
}

// Why: internal shape shared by listRecentWorkItems / listQueriedWorkItems so
// listWorkItems can lift per-side errors into the IPC envelope. The issue-side
// error is the specific new class of silent wrongness introduced by #1076 —
// PR-side errors existed before and are explicitly out of scope for this
// feature per the parent design doc §6.
type PartialWorkItemsResult = {
  items: MainWorkItem[]
  issuesError?: ClassifiedError
}

function assertSshRepoHasResolvedGitHubSource(args: {
  connectionId?: string | null
  issueOwnerRepo: OwnerRepo | null
  prOwnerRepo: OwnerRepo | null
}): void {
  if (!args.connectionId || args.issueOwnerRepo || args.prOwnerRepo) {
    return
  }
  // Why: SSH repo paths are remote-only, so gh cannot use cwd to infer repo
  // context. Without a resolved owner/repo, running gh would query local state.
  throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
}

type ResolvedPrWorkItemSource = {
  source: OwnerRepo | null
  originCandidate: OwnerRepo | null
  upstreamCandidate: OwnerRepo | null
}

async function resolvePrWorkItemSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedPrWorkItemSource> {
  const [originCandidate, upstreamCandidate] = await Promise.all([
    getOwnerRepo(repoPath, connectionId, localGitOptions),
    getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions)
  ])
  const source =
    preference === 'upstream' ? (upstreamCandidate ?? originCandidate) : originCandidate
  return { source, originCandidate, upstreamCandidate }
}

async function listRecentWorkItems(
  repoPath: string,
  issueOwnerRepo: OwnerRepo | null,
  prOwnerRepo: OwnerRepo | null,
  limit: number,
  connectionId?: string | null,
  noCache?: boolean,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const requiresExplicitRepo = Boolean(connectionId)
  const restCacheArgs = noCache ? [] : ['--cache', '120s']
  assertSshRepoHasResolvedGitHubSource({ connectionId, issueOwnerRepo, prOwnerRepo })
  if (issueOwnerRepo || prOwnerRepo || requiresExplicitRepo) {
    // Why: allSettled so a 403 on upstream issues doesn't zero out the origin
    // PR half — the UI renders partial results plus a banner for the failing
    // side, matching the parent design doc's partial-failure rule (§2).
    const [issuesSettled, prsSettled] = await Promise.allSettled([
      issueOwnerRepo
        ? ghExecFileAsync(
            [
              'api',
              ...restCacheArgs,
              `repos/${issueOwnerRepo.owner}/${issueOwnerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
            ],
            ghOptions
          )
        : requiresExplicitRepo
          ? Promise.resolve({ stdout: '[]' })
          : ghExecFileAsync(
              [
                'issue',
                'list',
                '--limit',
                String(limit),
                '--state',
                'open',
                '--json',
                WORK_ITEM_ISSUE_LIST_JSON_FIELDS
              ],
              ghOptions
            ),
      prOwnerRepo
        ? ghExecFileAsync(
            [
              'api',
              ...restCacheArgs,
              `repos/${prOwnerRepo.owner}/${prOwnerRepo.repo}/pulls?per_page=${limit}&state=open&sort=updated&direction=desc`
            ],
            ghOptions
          )
        : requiresExplicitRepo
          ? Promise.resolve({ stdout: '[]' })
          : ghExecFileAsync(
              [
                'pr',
                'list',
                '--limit',
                String(limit),
                '--state',
                'open',
                '--json',
                WORK_ITEM_PR_LIST_JSON_FIELDS
              ],
              ghOptions
            )
    ])

    let issues: MainWorkItem[] = []
    let issuesError: ClassifiedError | undefined
    if (issuesSettled.status === 'fulfilled') {
      issues = (JSON.parse(issuesSettled.value.stdout) as Record<string, unknown>[])
        // Why: the GitHub issues REST endpoint also returns pull requests with a
        // `pull_request` marker. The new-workspace task picker needs distinct
        // issue vs PR buckets, so drop PR-shaped issue rows here before merging.
        .filter((item) => !('pull_request' in item))
        .map(mapIssueWorkItem)
    } else {
      const stderr =
        issuesSettled.reason instanceof Error
          ? issuesSettled.reason.message
          : String(issuesSettled.reason)
      issuesError = classifyListIssuesError(stderr)
    }

    let prs: MainWorkItem[] = []
    if (prsSettled.status === 'fulfilled') {
      prs = (JSON.parse(prsSettled.value.stdout) as Record<string, unknown>[]).map((item) =>
        mapPullRequestWorkItem(item, prOwnerRepo)
      )
      prs = await hydrateWorkItemRepositoryMergeMetadata(prs, prOwnerRepo, ghOptions)
    } else {
      // Why: PR-side failures must preserve the pre-diff behavior of
      // Promise.all by re-throwing so the rejection propagates up through
      // listWorkItems to the renderer's cross-repo aggregator (which counts
      // the repo as failed). This feature is scoped to the issue-side silent
      // wrongness from #1076; PR errors must not be silently swallowed here.
      // Why: if the issue side ALSO failed, the classified issuesError would
      // otherwise be silently dropped when we throw the PR reason. Log it so
      // debugging both-sides-failed scenarios (e.g. 403 on both endpoints)
      // isn't blind to the issue-side classification.
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
      items: sortWorkItemsByUpdatedAt([...issues, ...prs]).slice(0, limit),
      issuesError
    }
  }

  // Why: the fallback path (non-GitHub remote — neither issueOwnerRepo nor
  // prOwnerRepo resolved) intentionally stays on Promise.all rather than the
  // Promise.allSettled + per-side classification used above. There are no
  // `sources` to surface on this branch and nothing for the partial-failure
  // banner to render, so a single-side failure here means the whole call is
  // effectively unusable for the feature — reject-all matches reality. If
  // non-GitHub remotes ever grow source metadata, revisit this symmetry.
  const [issuesResult, prsResult] = await Promise.all([
    ghExecFileAsync(
      [
        'issue',
        'list',
        '--limit',
        String(limit),
        '--state',
        'open',
        '--json',
        WORK_ITEM_ISSUE_LIST_JSON_FIELDS
      ],
      ghOptions
    ),
    ghExecFileAsync(
      [
        'pr',
        'list',
        '--limit',
        String(limit),
        '--state',
        'open',
        '--json',
        WORK_ITEM_PR_LIST_JSON_FIELDS
      ],
      ghOptions
    )
  ])

  const issues = (JSON.parse(issuesResult.stdout) as Record<string, unknown>[]).map(
    mapIssueWorkItem
  )
  const prs = (JSON.parse(prsResult.stdout) as Record<string, unknown>[]).map((item) =>
    mapPullRequestWorkItem(item, null)
  )

  return {
    items: sortWorkItemsByUpdatedAt([...issues, ...prs]).slice(0, limit)
  }
}

async function listQueriedWorkItems(
  repoPath: string,
  issueOwnerRepo: OwnerRepo | null,
  prOwnerRepo: OwnerRepo | null,
  query: ParsedTaskQuery,
  limit: number,
  before?: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const requiresExplicitRepo = Boolean(connectionId)
  assertSshRepoHasResolvedGitHubSource({ connectionId, issueOwnerRepo, prOwnerRepo })
  const hasPrOnlyFilter =
    query.state === 'merged' ||
    query.draft ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
  const issueScope = query.scope !== 'pr' && !hasPrOnlyFilter
  const prScope = query.scope !== 'issue'

  // Why: run the issue and PR fetches in parallel but surface the
  // issue-side error separately so the IPC envelope can carry it up. PR-side
  // failures retain the prior swallow-and-log behavior per parent doc §6.
  const issueFetch = (async (): Promise<PartialWorkItemsResult> => {
    if (!issueScope) {
      return { items: [] }
    }
    if (requiresExplicitRepo && !issueOwnerRepo) {
      return { items: [] }
    }
    const args = buildWorkItemListArgs({
      kind: 'issue',
      ownerRepo: issueOwnerRepo,
      limit,
      query,
      before
    })
    try {
      const { stdout } = await ghExecFileAsync(args, ghOptions)
      return {
        items: (JSON.parse(stdout) as Record<string, unknown>[]).map(mapIssueWorkItem)
      }
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      return { items: [], issuesError: classifyListIssuesError(stderr) }
    }
  })()

  const prFetch = (async (): Promise<MainWorkItem[]> => {
    if (!prScope) {
      return []
    }
    if (requiresExplicitRepo && !prOwnerRepo) {
      return []
    }
    const args = buildWorkItemListArgs({
      kind: 'pr',
      ownerRepo: prOwnerRepo,
      limit,
      query,
      before
    })
    try {
      const { stdout } = await ghExecFileAsync(args, ghOptions)
      const mapped = (JSON.parse(stdout) as Record<string, unknown>[]).map((item) =>
        mapPullRequestWorkItem(item, prOwnerRepo)
      )
      const hydrated = await hydrateWorkItemRepositoryMergeMetadata(mapped, prOwnerRepo, ghOptions)
      if (query.state === 'closed') {
        return hydrated.filter((item) => item.state !== 'merged')
      }
      return hydrated
    } catch (err) {
      console.warn('listQueriedWorkItems PRs partial failure:', err)
      return []
    }
  })()

  const [issueResult, prItems] = await Promise.all([issueFetch, prFetch])
  return {
    items: sortWorkItemsByUpdatedAt([...issueResult.items, ...prItems]).slice(0, limit),
    issuesError: issueResult.issuesError
  }
}

export async function listWorkItems(
  repoPath: string,
  limit = 24,
  query?: string,
  before?: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  noCache?: boolean,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ListWorkItemsResult<MainWorkItem>> {
  const trimmedQuery = query?.trim() ?? ''
  if (isGitHubWorkItemsQueryTooLarge(trimmedQuery)) {
    return {
      items: [],
      sources: {
        issues: null,
        prs: null,
        originCandidate: null,
        upstreamCandidate: null
      }
    }
  }
  const [issueResolved, prResolved] = await Promise.all([
    resolveIssueSource(repoPath, preference, connectionId, localGitOptions),
    resolvePrWorkItemSource(repoPath, preference, connectionId, localGitOptions)
  ])
  const issueOwnerRepo = issueResolved.source
  const prOwnerRepo = prResolved.source
  await acquire()
  try {
    // Why: errors propagate to IPC so the renderer's cross-repo aggregator can
    // count this repo as failed and surface the partial-failure banner. A
    // catch-all here would make an auth/network failure indistinguishable from
    // an empty result and silently under-report per-repo failures.
    const partial = !trimmedQuery
      ? await listRecentWorkItems(
          repoPath,
          issueOwnerRepo,
          prOwnerRepo,
          limit,
          connectionId,
          noCache,
          localGitOptions
        )
      : await listQueriedWorkItems(
          repoPath,
          issueOwnerRepo,
          prOwnerRepo,
          parseTaskQuery(trimmedQuery),
          limit,
          before,
          connectionId,
          localGitOptions
        )

    const errors = partial.issuesError ? { issues: partial.issuesError } : undefined
    return {
      items: partial.items,
      sources: {
        issues: issueOwnerRepo,
        prs: prOwnerRepo,
        originCandidate: prResolved.originCandidate,
        upstreamCandidate: prResolved.upstreamCandidate
      },
      ...(errors ? { errors } : {}),
      ...(issueResolved.fellBack ? { issueSourceFellBack: true } : {})
    }
  } finally {
    release()
  }
}

function buildSearchQueryString(
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
    // Why: GitHub search treats merged PRs as closed. Exclude merged so the
    // "Closed" filter actually means closed-without-merge.
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

function quoteGitHubSearchValue(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

async function countWorkItemsForQuery(
  repoPath: string,
  ownerRepo: OwnerRepo,
  query: ParsedTaskQuery,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<number> {
  const searchQ = buildSearchQueryString(ownerRepo, query)
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
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
  return parseInt(stdout.trim(), 10) || 0
}

function sameOwnerRepo(left: OwnerRepo | null, right: OwnerRepo | null): boolean {
  // Why: GitHub treats owner and repo names as case-insensitive, so remotes
  // with different casing (StablyAI/Orca vs stablyai/orca) point at the same
  // repo and should not split into two search queries.
  return (
    left?.owner.toLowerCase() === right?.owner.toLowerCase() &&
    left?.repo.toLowerCase() === right?.repo.toLowerCase()
  )
}

function defaultOpenWorkItemQuery(): ParsedTaskQuery {
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

// Why: uses GitHub's search API to get total_count without fetching items.
// This powers the pagination bar so the user sees total pages upfront.
// Cached for 120s to avoid burning the search rate limit (30 req/min).
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
    resolveIssueSource(repoPath, preference, connectionId, localGitOptions),
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
    // Why: `draft`, `reviewRequested`, and `reviewedBy` are PR-only predicates.
    // When present, the issue half would always return 0 and wastes a search
    // API call — skip the issue half entirely in that case.
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
    // Why: allSettled so a single failing search (e.g. transient network, rate
    // limit on one side) doesn't silently zero out the total; sum only the
    // fulfilled halves instead.
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

export async function getRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<{ owner: string; repo: string } | null> {
  return getOwnerRepo(repoPath, connectionId, ...hostedReviewLocalGitOptionArgs(options))
}

/**
 * Resolve a fork's upstream/parent owner/repo, or null when the repo is not a
 * fork. Why: a fork's `origin` points at the personal copy, so repo identity
 * (notably the avatar) should prefer the upstream. Fast-paths the `upstream`
 * remote (offline); otherwise asks the GitHub API for the fork parent. The API
 * call targets the explicit origin slug, so it works for SSH repos too.
 * Best-effort: any failure (offline, unauthed, non-GitHub) resolves to null.
 */
export async function getRepoUpstream(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<OwnerRepo | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const origin = await getOwnerRepo(repoPath, connectionId, ...localGitArgs)
  if (!origin) {
    return null
  }
  const upstreamRemote = await getOwnerRepoForRemote(
    repoPath,
    'upstream',
    connectionId,
    ...localGitArgs
  )
  if (upstreamRemote && !sameOwnerRepo(upstreamRemote, origin)) {
    return upstreamRemote
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      ['repo', 'view', `${origin.owner}/${origin.repo}`, '--json', 'isFork,parent'],
      // Why: best-effort fork lookup runs at add-time; cap latency so a stalled
      // gh process can't hold up repo creation.
      {
        ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
        timeout: 10_000
      }
    )
    const data = JSON.parse(stdout) as {
      isFork?: boolean
      parent?: { name?: string; owner?: { login?: string } } | null
    }
    const owner = data.parent?.owner?.login
    const repo = data.parent?.name
    return data.isFork && owner && repo ? { owner, repo } : null
  } catch {
    return null
  } finally {
    release()
  }
}

function classifyCreatePRError(error: unknown): CreateHostedReviewResult {
  const { stderr, stdout } = extractExecError(error)
  const message = `${stderr}\n${stdout}`.trim()
  if (message) {
    console.warn('createGitHubPullRequest failed:', message)
  }
  const lower = message.toLowerCase()
  if (
    lower.includes('not logged') ||
    lower.includes('not authenticated') ||
    lower.includes('authentication') ||
    lower.includes('gh auth login') ||
    lower.includes('http 401')
  ) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: GitHub is not authenticated. Next step: run gh auth login in this environment.'
    }
  }
  if (lower.includes('already exists') || lower.includes('a pull request already exists')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.'
    }
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'PR creation may have completed. Refreshing branch review state...'
    }
  }
  if (lower.includes('validation failed') || lower.includes('http 422')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: GitHub rejected the pull request. Check the base branch and branch state, then try again.'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create PR failed: GitHub could not create the pull request. Try again in a moment.'
  }
}

function parseCreatePRPayload(stdout: string): { number: number; url: string } | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as { number?: unknown; url?: unknown }
    const number = Number(parsed.number)
    const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
    if (Number.isInteger(number) && number > 0 && url) {
      return { number, url }
    }
  } catch {
    // Fall through to URL parsing for older gh versions without --json support.
  }
  const urlMatch = trimmed.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/)
  if (!urlMatch) {
    return null
  }
  return { number: Number(urlMatch[1]), url: urlMatch[0] }
}

async function findOpenPRByHeadBase(args: {
  repoPath: string
  ownerRepo: OwnerRepo
  head: string
  base: string
  connectionId?: string | null
  options?: HostedReviewExecutionOptions
}): Promise<{ number: number; url: string } | null> {
  const context = githubRepoContext(args.repoPath, args.connectionId)
  const { stdout } = await ghExecFileAsync(
    [
      'pr',
      'list',
      '--repo',
      `${args.ownerRepo.owner}/${args.ownerRepo.repo}`,
      '--head',
      args.head,
      '--base',
      args.base,
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'number,url'
    ],
    {
      ...ghRepoExecOptions(context),
      ...(args.connectionId ? {} : getHostedReviewLocalGitOptions(args.options))
    }
  )
  const list = JSON.parse(stdout) as { number?: number; url?: string }[]
  if (list.length !== 1 || !list[0]?.number || !list[0]?.url) {
    return null
  }
  return { number: list[0].number, url: list[0].url }
}

async function readPullRequestTemplate(
  repoPath: string,
  connectionId?: string | null
): Promise<string> {
  const relativeCandidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md'
  ]
  const remoteProvider = connectionId ? getSshFilesystemProvider(connectionId) : undefined
  if (connectionId && !remoteProvider) {
    return ''
  }
  for (const relativeCandidate of relativeCandidates) {
    try {
      if (remoteProvider) {
        const result = await remoteProvider.readFile(
          joinWorktreeRelativePath(repoPath, relativeCandidate)
        )
        if (result.isBinary) {
          continue
        }
        return result.content
      }
      return await readFile(join(repoPath, relativeCandidate), 'utf8')
    } catch {
      // Try the next conventional PR template path.
    }
  }
  return ''
}

export async function createGitHubPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  const ownerRepo = await getOwnerRepo(
    repoPath,
    connectionId,
    ...hostedReviewLocalGitOptionArgs(options)
  )
  if (!ownerRepo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a GitHub remote.'
    }
  }

  const base = normalizeHostedReviewBaseRef(input.base)
  const head = input.head ? normalizeHostedReviewHeadRef(input.head) || undefined : undefined
  const title = input.title.trim()
  if (!base || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: base branch and title are required.'
    }
  }
  if (head && head.toLowerCase() === base.toLowerCase()) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: choose a different base branch before creating a pull request.'
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'orca-pr-body-'))
  await acquire()
  const bodyPath = join(tempDir, 'body.md')
  try {
    const body =
      input.useTemplate && !input.body?.trim()
        ? await readPullRequestTemplate(repoPath, connectionId)
        : (input.body ?? '')
    await writeFile(bodyPath, body, 'utf8')
    const createArgs = [
      'pr',
      'create',
      '--repo',
      `${ownerRepo.owner}/${ownerRepo.repo}`,
      '--base',
      base,
      '--title',
      title,
      '--body-file',
      bodyPath
    ]
    if (head) {
      createArgs.push('--head', head)
    }
    if (input.draft) {
      createArgs.push('--draft')
    }
    try {
      const context = githubRepoContext(repoPath, connectionId)
      const { stdout } = await ghExecFileAsync(createArgs, {
        ...ghRepoExecOptions(context),
        ...(connectionId ? {} : getHostedReviewLocalGitOptions(options)),
        timeout: 60_000,
        idempotent: false
      })
      const created = parseCreatePRPayload(stdout)
      if (created) {
        return { ok: true, ...created }
      }
      const found = head
        ? await findOpenPRByHeadBase({
            repoPath,
            ownerRepo,
            head,
            base,
            connectionId,
            options
          }).catch(() => null)
        : null
      if (found) {
        return { ok: true, ...found }
      }
      return {
        ok: false,
        code: 'unknown_completion',
        error: 'PR creation may have completed. Refreshing branch review state...'
      }
    } catch (error) {
      const classified = classifyCreatePRError(error)
      if (
        !classified.ok &&
        (classified.code === 'already_exists' || classified.code === 'unknown_completion') &&
        head
      ) {
        const existing = await findOpenPRByHeadBase({
          repoPath,
          ownerRepo,
          head,
          base,
          connectionId,
          options
        }).catch(() => null)
        if (existing) {
          return {
            ok: false,
            code: 'already_exists',
            error: 'A pull request already exists for this branch.',
            existingReview: existing
          }
        }
      }
      return classified
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    release()
  }
}

export async function getWorkItem(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueWorkItem(
        repoPath,
        await getIssueOwnerRepo(repoPath, connectionId, localGitOptions),
        number,
        connectionId,
        localGitOptions
      )
    }
    if (type === 'pr') {
      return await fetchPullRequestWorkItem(
        repoPath,
        await getOwnerRepo(repoPath, connectionId, localGitOptions),
        number,
        connectionId,
        localGitOptions
      )
    }

    try {
      const issue = await fetchIssueWorkItem(
        repoPath,
        await getIssueOwnerRepo(repoPath, connectionId, localGitOptions),
        number,
        connectionId,
        localGitOptions
      )
      if (issue) {
        return issue
      }
    } catch (err) {
      // Why: the issue lookup now targets `upstream` while the PR lookup targets `origin`,
      // so a transient upstream failure (5xx, rate limit, network flake) on issue #N would
      // silently fall through to origin's PR #N — potentially a completely unrelated item.
      // Only fall through when the issue genuinely doesn't exist (404); re-throw everything
      // else so the outer catch returns null and the caller sees a real failure instead of
      // a wrong item. classifyGhError centralizes the 404/"not found" pattern-matching.
      const stderr = err instanceof Error ? err.message : String(err)
      if (classifyGhError(stderr).type !== 'not_found') {
        throw err
      }
    }
    return await fetchPullRequestWorkItem(
      repoPath,
      await getOwnerRepo(repoPath, connectionId, localGitOptions),
      number,
      connectionId,
      localGitOptions
    )
  } catch {
    return null
  } finally {
    release()
  }
}

export async function getWorkItemByOwnerRepo(
  repoPath: string,
  ownerRepo: OwnerRepo,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueWorkItem(repoPath, ownerRepo, number, connectionId, localGitOptions)
    }
    return await fetchPullRequestWorkItem(
      repoPath,
      ownerRepo,
      number,
      connectionId,
      localGitOptions
    )
  } catch {
    return null
  } finally {
    release()
  }
}

type PullRequestLookupData = {
  number: number
  title: string
  state: string
  url: string
  statusCheckRollup: unknown[]
  updatedAt: string
  isDraft?: boolean
  mergeable: string
  reviewDecision?: PRReviewDecision | null
  autoMergeRequest?: unknown
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  baseRefName?: string
  headRefName?: string
  baseRefOid?: string
  headRefOid?: string
}

type RestPullRequest = {
  number: number
  title: string
  state: string
  html_url?: string
  url?: string
  updated_at?: string
  draft?: boolean
  merged_at?: string | null
  mergeable?: boolean | null
  mergeable_state?: string | null
  base?: { ref?: string; sha?: string }
  head?: { ref?: string; sha?: string }
}

const PR_LOOKUP_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
const PR_BRANCH_LIST_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'

export type GitHubPRBranchLookupOptions = HostedReviewExecutionOptions & {
  acceptMergedFallbackPR?: boolean
}

function mapRestPRMergeable(pr: RestPullRequest): PRMergeableState {
  const mergeableState = pr.mergeable_state?.toLowerCase()
  if (mergeableState === 'dirty') {
    return 'CONFLICTING'
  }
  if (mergeableState === 'clean' || pr.mergeable === true) {
    return 'MERGEABLE'
  }
  return 'UNKNOWN'
}

function derivePullRequestMergeable(data: PullRequestLookupData): PRMergeableState {
  const mergeable = normalizePRMergeable(data.mergeable)
  if (mergeable === 'CONFLICTING' || data.mergeStateStatus === 'DIRTY') {
    return 'CONFLICTING'
  }
  return mergeable ?? 'UNKNOWN'
}

function mapRestPullRequest(pr: RestPullRequest): PullRequestLookupData {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'MERGED' : pr.state,
    url: pr.html_url ?? pr.url ?? '',
    statusCheckRollup: [],
    updatedAt: pr.updated_at ?? '',
    isDraft: pr.draft,
    mergeable: mapRestPRMergeable(pr),
    baseRefName: pr.base?.ref,
    headRefName: pr.head?.ref,
    baseRefOid: pr.base?.sha,
    headRefOid: pr.head?.sha
  }
}

function isMergedImplicitPR(data: PullRequestLookupData, linkedPRNumber?: number | null): boolean {
  // Why: merged PRs are historical branch matches unless the worktree has an
  // explicit PR link. Showing them as implicit review context leaves nothing
  // meaningful to unlink after the branch has been rebased or merged.
  return typeof linkedPRNumber !== 'number' && mapPRState(data.state, data.isDraft) === 'merged'
}

async function getCurrentHeadOid(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<string | null> {
  try {
    const provider = connectionId ? getSshGitProvider(connectionId) : null
    const result = provider
      ? await provider.exec(['rev-parse', 'HEAD'], repoPath)
      : await gitExecFileAsync(['rev-parse', 'HEAD'], {
          cwd: repoPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

function shouldHideMergedImplicitPR(
  data: PullRequestLookupData | null,
  linkedPRNumber: number | null | undefined,
  currentHeadOid: string | null
): boolean {
  if (!data || !isMergedImplicitPR(data, linkedPRNumber)) {
    return false
  }
  // Why: keep hiding historical merged branch matches, but preserve the merged
  // PR for the exact commit currently checked out in the sidebar.
  return !currentHeadOid || data.headRefOid !== currentHeadOid
}

function normalizePullRequestLookupData(data: PullRequestLookupData): PullRequestLookupData {
  return {
    ...data,
    reviewDecision:
      data.reviewDecision !== undefined ? normalizeReviewDecision(data.reviewDecision) : undefined,
    autoMergeEnabled:
      data.autoMergeEnabled ??
      ('autoMergeRequest' in data ? isAutoMergeEnabled(data.autoMergeRequest) : undefined)
  }
}

function cacheRepositoryMergeMetadata(
  cacheKey: string,
  value: GitHubRepositoryMergeMetadata,
  ttlMs: number
): void {
  const now = Date.now()
  pruneRepositoryMergeMetadataCache(now)
  // Why: merge metadata is keyed by user-controlled branch names. Keep the
  // per-session cache bounded even if many short-lived branches are inspected.
  repositoryMergeMetadataCache.delete(cacheKey)
  repositoryMergeMetadataCache.set(cacheKey, {
    value,
    expiresAt: now + ttlMs
  })
  pruneRepositoryMergeMetadataCache(now)
}

async function detectRepositoryMergeMetadata(
  ownerRepo: OwnerRepo,
  branchName: string | undefined,
  ghOptions: GhExecOptions
): Promise<GitHubRepositoryMergeMetadata> {
  const cacheKey = `${ownerRepo.owner.toLowerCase()}/${ownerRepo.repo.toLowerCase()}:${
    branchName ?? '__repo__'
  }`
  pruneRepositoryMergeMetadataCache()
  const cached = repositoryMergeMetadataCache.get(cacheKey)
  if (cached) {
    return cached.value
  }
  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    return { mergeQueueRequired: null, autoMergeAllowed: null }
  }
  const query = branchName
    ? `query($owner: String!, $repo: String!, $branch: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
      mergeQueue(branch: $branch) { id }
    }
  }`
    : `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
    }
  }`
  try {
    noteRateLimitSpend('graphql')
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`
    ]
    if (branchName) {
      args.push('-f', `branch=${branchName}`)
    }
    const { stdout } = await ghExecFileAsync(args, ghOptions)
    const parsed = JSON.parse(stdout) as {
      data?: {
        repository?: {
          viewerDefaultMergeMethod?: unknown
          mergeCommitAllowed?: unknown
          rebaseMergeAllowed?: unknown
          squashMergeAllowed?: unknown
          autoMergeAllowed?: unknown
          mergeQueue?: { id?: unknown } | null
        } | null
      }
    }
    const repository = parsed.data?.repository
    const mergeMethodSettings = repository
      ? normalizeGitHubPRMergeMethodSettings({
          defaultMethod: repository.viewerDefaultMergeMethod,
          mergeCommitAllowed: repository.mergeCommitAllowed,
          rebaseMergeAllowed: repository.rebaseMergeAllowed,
          squashMergeAllowed: repository.squashMergeAllowed
        })
      : undefined
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: branchName ? Boolean(repository?.mergeQueue) : null,
      autoMergeAllowed:
        typeof repository?.autoMergeAllowed === 'boolean' ? repository.autoMergeAllowed : null,
      ...(mergeMethodSettings ? { mergeMethodSettings } : {})
    }
    cacheRepositoryMergeMetadata(cacheKey, value, MERGE_QUEUE_CACHE_TTL_MS)
    return value
  } catch {
    // Why: failed merge-queue probes should stay conservative without
    // retrying GraphQL on every status poll while GitHub/network is unhappy.
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: null,
      autoMergeAllowed: null
    }
    cacheRepositoryMergeMetadata(cacheKey, value, MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS)
    return value
  }
}

async function hydratePullRequestLookupData(
  ownerRepo: OwnerRepo,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions
): Promise<PullRequestLookupData> {
  const normalized = normalizePullRequestLookupData(data)
  const hasRichMergeFields =
    'reviewDecision' in data || 'mergeStateStatus' in data || 'autoMergeRequest' in data
  const mergeMetadata = hasRichMergeFields
    ? await detectRepositoryMergeMetadata(ownerRepo, normalized.baseRefName, ghOptions)
    : undefined
  return {
    ...normalized,
    ...(mergeMetadata ? { mergeQueueRequired: mergeMetadata.mergeQueueRequired } : {}),
    ...(mergeMetadata ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed } : {}),
    ...(mergeMetadata?.mergeMethodSettings
      ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
      : {})
  }
}

async function hydrateBranchLookupWithExactPR(
  ownerRepo: OwnerRepo,
  branchData: PullRequestLookupData | null,
  ghOptions: GhExecOptions
): Promise<PullRequestLookupData | null> {
  if (!branchData) {
    return null
  }
  try {
    return (await getPRByNumber(ownerRepo, branchData.number, ghOptions)) ?? branchData
  } catch {
    return branchData
  }
}

async function getRestPRForBranch(
  prRepo: OwnerRepo,
  headOwner: string,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${headOwner}:${branchName}`)
  const { stdout } = await ghExecFileAsync(
    ['api', `repos/${prRepo.owner}/${prRepo.repo}/pulls?head=${head}&state=all&per_page=1`],
    ghOptions
  )
  const list = JSON.parse(stdout) as RestPullRequest[]
  const pr = list[0]
  return pr ? mapRestPullRequest(pr) : null
}

async function getFallbackPRListForBranch(
  prRepo: OwnerRepo,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const { stdout } = await ghExecFileAsync(
    [
      'pr',
      'list',
      '--repo',
      `${prRepo.owner}/${prRepo.repo}`,
      '--head',
      branchName,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      PR_BRANCH_LIST_JSON_FIELDS
    ],
    ghOptions
  )
  const list = JSON.parse(stdout) as PullRequestLookupData[]
  return list[0] ?? null
}

type TrackedUpstreamBranch = {
  remoteName: string
  branchName: string
}

const TRACKED_UPSTREAM_NULL_CACHE_TTL_MS = 30_000

type TrackedUpstreamNullCacheEntry = {
  expiresAt: number
}

const trackedUpstreamNullCache = new Map<string, TrackedUpstreamNullCacheEntry>()
const trackedUpstreamInFlight = new Map<string, Promise<TrackedUpstreamBranch | null>>()

export function __resetTrackedUpstreamBranchCacheForTests(): void {
  trackedUpstreamNullCache.clear()
  trackedUpstreamInFlight.clear()
}

function parseTrackedUpstreamBranch(
  upstreamRef: string,
  branchName: string
): TrackedUpstreamBranch | null {
  const parsed = splitRemoteBranchName(upstreamRef.trim())
  if (!parsed || parsed.branchName === branchName) {
    return null
  }
  return parsed
}

async function getTrackedUpstreamBranch(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<TrackedUpstreamBranch | null> {
  // Why: branches without configured upstreams are stable misses during PR
  // polling; cache only nulls so positive PR discovery stays fresh.
  const cacheKey = getTrackedUpstreamBranchCacheKey(
    repoPath,
    branchName,
    connectionId,
    localGitOptions
  )
  const now = Date.now()
  const cachedNull = trackedUpstreamNullCache.get(cacheKey)
  if (cachedNull && cachedNull.expiresAt > now) {
    return null
  }
  if (cachedNull) {
    trackedUpstreamNullCache.delete(cacheKey)
  }

  const inFlight = trackedUpstreamInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const probe = probeTrackedUpstreamBranch(repoPath, branchName, connectionId, localGitOptions)
  trackedUpstreamInFlight.set(cacheKey, probe)
  try {
    const result = await probe
    if (result) {
      trackedUpstreamNullCache.delete(cacheKey)
    } else {
      trackedUpstreamNullCache.set(cacheKey, {
        expiresAt: now + TRACKED_UPSTREAM_NULL_CACHE_TTL_MS
      })
    }
    return result
  } finally {
    if (trackedUpstreamInFlight.get(cacheKey) === probe) {
      trackedUpstreamInFlight.delete(cacheKey)
    }
  }
}

function getTrackedUpstreamBranchCacheKey(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): string {
  const runtimeKey = connectionId
    ? `ssh:${connectionId}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  return [runtimeKey, repoPath, branchName].join('\0')
}

async function probeTrackedUpstreamBranch(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<TrackedUpstreamBranch | null> {
  const args = ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchName}@{upstream}`]
  try {
    const provider = connectionId ? getSshGitProvider(connectionId) : null
    const result = provider
      ? await provider.exec(args, repoPath)
      : await gitExecFileAsync(args, {
          cwd: repoPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    return parseTrackedUpstreamBranch(result.stdout, branchName)
  } catch {
    return null
  }
}

async function lookupPRByBranchName(args: {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
  branchName: string
  ghOptions: GhExecOptions
}): Promise<{ data: PullRequestLookupData | null; dataRepo: OwnerRepo | null }> {
  if (args.candidates.length > 0) {
    for (const candidate of args.candidates) {
      try {
        const branchData = args.headRepo
          ? await getRestPRForBranch(
              candidate,
              args.headRepo.owner,
              args.branchName,
              args.ghOptions
            )
          : await getFallbackPRListForBranch(candidate, args.branchName, args.ghOptions)
        // Why: REST/list branch lookup identifies the PR cheaply; exact
        // `gh pr view` carries review, merge queue, and auto-merge state.
        const data = await hydrateBranchLookupWithExactPR(candidate, branchData, args.ghOptions)
        if (data) {
          return { data, dataRepo: candidate }
        }
      } catch (err) {
        if (args.headRepo) {
          throw err
        }
        const branchData = await getRestPRForBranch(
          candidate,
          candidate.owner,
          args.branchName,
          args.ghOptions
        )
        const data = await hydrateBranchLookupWithExactPR(candidate, branchData, args.ghOptions)
        if (data) {
          return { data, dataRepo: candidate }
        }
      }
    }
    return { data: null, dataRepo: null }
  }

  try {
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', args.branchName, '--json', PR_LOOKUP_JSON_FIELDS],
      args.ghOptions
    )
    return {
      data: normalizePullRequestLookupData(JSON.parse(stdout) as PullRequestLookupData),
      dataRepo: null
    }
  } catch (err) {
    if (isNoPullRequestError(err)) {
      return { data: null, dataRepo: null }
    }
    throw err
  }
}

async function getRestPRByNumber(
  ownerRepo: OwnerRepo,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const { stdout } = await ghExecFileAsync(
    ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
    ghOptions
  )
  return mapRestPullRequest(JSON.parse(stdout) as RestPullRequest)
}

async function getPRByNumber(
  ownerRepo: OwnerRepo,
  number: number,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'pr',
        'view',
        String(number),
        '--repo',
        `${ownerRepo.owner}/${ownerRepo.repo}`,
        '--json',
        PR_LOOKUP_JSON_FIELDS
      ],
      ghOptions
    )
    return hydratePullRequestLookupData(
      ownerRepo,
      JSON.parse(stdout) as PullRequestLookupData,
      ghOptions
    )
  } catch (err) {
    // Why: deleted or manually edited linked PR metadata should fall back to
    // branch discovery; quota/auth/network failures get one cheaper REST exact lookup.
    if (isNotFoundGhError(err)) {
      return null
    }
    try {
      const restData = await getRestPRByNumber(ownerRepo, number, ghOptions)
      return restData ? hydratePullRequestLookupData(ownerRepo, restData, ghOptions) : null
    } catch (restErr) {
      if (isNotFoundGhError(restErr)) {
        return null
      }
      if (!shouldStopAfterExactLookupError(restErr)) {
        return null
      }
      throw restErr
    }
  }
}

async function lookupPRByNumber(args: {
  candidates: OwnerRepo[]
  number: number
  ghOptions: ReturnType<typeof ghRepoExecOptions>
}): Promise<{ data: PullRequestLookupData | null; dataRepo: OwnerRepo | null }> {
  for (const candidate of args.candidates) {
    try {
      const linkedData = await getPRByNumber(candidate, args.number, args.ghOptions)
      if (!linkedData) {
        continue
      }
      return { data: linkedData, dataRepo: candidate }
    } catch (err) {
      if (shouldStopAfterExactLookupError(err)) {
        throw err
      }
      // Candidate probing is best-effort; another repo may own the PR.
    }
  }

  if (args.candidates.length > 0) {
    return { data: null, dataRepo: null }
  }

  try {
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(args.number), '--json', PR_LOOKUP_JSON_FIELDS],
      args.ghOptions
    )
    return {
      data: normalizePullRequestLookupData(JSON.parse(stdout) as PullRequestLookupData),
      dataRepo: null
    }
  } catch (err) {
    if (isNoPullRequestError(err)) {
      // Why: stale cached fallback numbers should not turn every poll into an
      // error when the PR was deleted or belonged to a different repo.
      return { data: null, dataRepo: null }
    }
    throw err
  }
}

function isNotFoundGhError(err: unknown): boolean {
  const stderr = err instanceof Error ? err.message : String(err)
  return classifyGhError(stderr).type === 'not_found'
}

function shouldStopAfterExactLookupError(err: unknown): boolean {
  const stderr = err instanceof Error ? err.message : String(err)
  const type = classifyGhError(stderr).type
  return type !== 'not_found'
}

/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 *
 * When `linkedPRNumber` is provided, it is the source of truth. This handles
 * "create from PR" worktrees whose local branch differs from the PR head ref,
 * and prevents a coalesced linked-PR refresh from fanning out an unrelated
 * branch lookup result to sibling aliases.
 * `fallbackPRNumber` is weaker: branch lookup still wins, and exact lookup is
 * used only after branch lookup misses.
 */
export async function getPRForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PRInfo | null> {
  const outcome = await getPRForBranchOutcome(
    repoPath,
    branch,
    linkedPRNumber,
    connectionId,
    fallbackPRNumber,
    options
  )
  return outcome.kind === 'found' ? outcome.pr : null
}

export async function getPRForBranchOutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PRRefreshOutcome> {
  // Strip refs/heads/ prefix if present
  const branchName = branch.replace(/^refs\/heads\//, '')
  // Why: detached HEAD cannot use branch lookup, but an exact linked/fallback
  // PR number remains safe to query and keeps review state visible.
  if (!branchName && typeof linkedPRNumber !== 'number' && typeof fallbackPRNumber !== 'number') {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)

  await acquire()
  try {
    const { candidates, headRepo } = await resolvePRRepositoryCandidates(
      repoPath,
      connectionId,
      ...localGitArgs
    )
    let data: PullRequestLookupData | null = null
    let dataRepo: OwnerRepo | null = null
    let dataHeadRepo: OwnerRepo | null = headRepo
    let currentHeadOidForMergedImplicit: string | null | undefined

    const hideMergedImplicitPR = async (candidate: PullRequestLookupData | null) => {
      if (!candidate || !isMergedImplicitPR(candidate, linkedPRNumber)) {
        return false
      }
      currentHeadOidForMergedImplicit ??= await getCurrentHeadOid(
        repoPath,
        connectionId,
        localGitOptions
      )
      return shouldHideMergedImplicitPR(candidate, linkedPRNumber, currentHeadOidForMergedImplicit)
    }

    if (typeof linkedPRNumber === 'number') {
      const exactLookup = await lookupPRByNumber({
        candidates,
        number: linkedPRNumber,
        ghOptions
      })
      data = exactLookup.data
      dataRepo = exactLookup.dataRepo
    } else if (branchName) {
      // During a rebase the worktree is in detached HEAD and branch is empty.
      // An empty --head filter causes gh to return an arbitrary PR.
      const branchLookup = await lookupPRByBranchName({
        candidates,
        headRepo,
        branchName,
        ghOptions
      })
      data = branchLookup.data
      dataRepo = branchLookup.dataRepo
      if (!data) {
        // Why: worktrees can have a short local branch tracking a differently
        // named remote PR head; after the local miss, try that configured head.
        const upstreamBranch = await getTrackedUpstreamBranch(
          repoPath,
          branchName,
          connectionId,
          localGitOptions
        )
        if (upstreamBranch) {
          const upstreamHeadRepo =
            (await getOwnerRepoForRemote(
              repoPath,
              upstreamBranch.remoteName,
              connectionId,
              ...localGitArgs
            )) ?? headRepo
          const upstreamLookup = await lookupPRByBranchName({
            candidates,
            headRepo: upstreamHeadRepo,
            branchName: upstreamBranch.branchName,
            ghOptions
          })
          data = upstreamLookup.data
          dataRepo = upstreamLookup.dataRepo
          if (data) {
            dataHeadRepo = upstreamHeadRepo
          }
        }
      }
    }
    let mergedBranchLookupNumber: number | null = null
    if (await hideMergedImplicitPR(data)) {
      mergedBranchLookupNumber = data?.number ?? null
      data = null
      dataRepo = null
      dataHeadRepo = headRepo
    }
    if (!data && typeof linkedPRNumber !== 'number' && typeof fallbackPRNumber === 'number') {
      const fallbackLookup = await lookupPRByNumber({
        candidates,
        number: fallbackPRNumber,
        ghOptions
      })
      data = fallbackLookup.data
      dataRepo = fallbackLookup.dataRepo
    }
    if (!data) {
      return { kind: 'no-pr', fetchedAt: Date.now() }
    }
    const fallbackConfirmedMergedBranch =
      typeof fallbackPRNumber === 'number' &&
      mergedBranchLookupNumber === fallbackPRNumber &&
      data.number === fallbackPRNumber
    // Why: a currently visible PR can be merged outside Orca; when the caller
    // marks the fallback as visible review state, keep its lifecycle fresh even
    // if GitHub no longer reports it by branch (for example deleted heads).
    if (
      (await hideMergedImplicitPR(data)) &&
      !fallbackConfirmedMergedBranch &&
      options.acceptMergedFallbackPR !== true
    ) {
      return { kind: 'no-pr', fetchedAt: Date.now() }
    }

    const mergeable = derivePullRequestMergeable(data)
    const conflictSummary =
      !connectionId &&
      mergeable === 'CONFLICTING' &&
      data.baseRefName &&
      data.baseRefOid &&
      data.headRefOid
        ? await getPRConflictSummary(
            repoPath,
            data.baseRefName,
            data.baseRefOid,
            data.headRefOid,
            localGitOptions
          )
        : undefined

    return {
      kind: 'found',
      fetchedAt: Date.now(),
      pr: {
        number: data.number,
        title: data.title,
        state: mapPRState(data.state, data.isDraft),
        url: data.url,
        checksStatus: deriveCheckStatus(data.statusCheckRollup),
        updatedAt: data.updatedAt,
        mergeable,
        ...(data.reviewDecision !== undefined ? { reviewDecision: data.reviewDecision } : {}),
        ...(data.autoMergeEnabled !== undefined ? { autoMergeEnabled: data.autoMergeEnabled } : {}),
        ...(data.autoMergeAllowed !== undefined ? { autoMergeAllowed: data.autoMergeAllowed } : {}),
        ...(data.mergeQueueRequired !== undefined
          ? { mergeQueueRequired: data.mergeQueueRequired }
          : {}),
        ...(data.mergeMethodSettings !== undefined
          ? { mergeMethodSettings: data.mergeMethodSettings }
          : {}),
        ...(data.mergeStateStatus !== undefined ? { mergeStateStatus: data.mergeStateStatus } : {}),
        headSha: data.headRefOid,
        ...(data.baseRefName ? { baseRefName: data.baseRefName } : {}),
        prRepo: dataRepo ?? undefined,
        headRepo: dataHeadRepo ?? undefined,
        conflictSummary
      }
    }
  } catch (err) {
    return prRefreshUpstreamError(err)
  } finally {
    release()
  }
}

/**
 * Get detailed check statuses for a PR.
 * When branch is provided, uses gh api --cache with the check-runs REST endpoint
 * so 304 Not Modified responses don't count against the rate limit.
 */
export async function getPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: OwnerRepo | null,
  options?: { noCache?: boolean },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  const fallbackToPRChecks = async (): Promise<PRCheckDetail[]> => {
    // Why: the REST check-runs path spends core only. Guard GraphQL only when
    // we actually fall back to `gh pr checks`, so a low GraphQL bucket does not
    // block fresh REST check data. Keep this outside the gh lock because the
    // guard may need its own `gh api rate_limit` call.
    await assertRateLimitBudget('graphql')
    await acquire()
    try {
      const fallbackArgs = ['pr', 'checks', String(prNumber), '--json', 'name,state,link']
      if (ownerRepo) {
        fallbackArgs.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
      }
      const { stdout } = await ghExecFileAsync(fallbackArgs, ghOptions).catch((err: unknown) => {
        const { stderr } = extractExecError(err)
        // Why: `gh pr checks` exits non-zero when a PR genuinely has no check
        // runs yet. Treat that as an empty optional section, not a load failure.
        if (stderr.toLowerCase().includes('no checks reported')) {
          return { stdout: '[]', stderr }
        }
        throw err
      })
      noteRateLimitSpend('graphql')
      const data = JSON.parse(stdout) as { name: string; state: string; link: string }[]
      return data.map((d) => ({
        name: d.name,
        status: mapCheckStatus(d.state),
        conclusion: mapCheckConclusion(d.state),
        url: d.link || null,
        workflowRunId: parseActionsRunId(d.link)
      }))
    } finally {
      release()
    }
  }

  if (ownerRepo && headSha) {
    let canUseRestChecks = true
    try {
      await assertRateLimitBudget('core')
    } catch (err) {
      canUseRestChecks = false
      console.warn('getPRChecks skipped REST check-runs, falling back to gh pr checks:', err)
    }
    if (canUseRestChecks) {
      await acquire()
      try {
        // Why: --cache 60s saves rate-limit budget during polling, but when the
        // user explicitly clicks refresh we must skip it so gh fetches fresh data.
        const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            ...cacheArgs,
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`
          ],
          ghOptions
        )
        noteRateLimitSpend('core')
        const data = JSON.parse(stdout) as {
          check_runs: {
            id?: number
            name: string
            status: string
            conclusion: string | null
            html_url: string
            details_url: string | null
          }[]
        }
        if (data.check_runs.length > 0) {
          return data.check_runs.map((d) => ({
            name: d.name,
            status: mapCheckRunRESTStatus(d.status),
            conclusion: mapCheckRunRESTConclusion(d.status, d.conclusion),
            url: d.details_url || d.html_url || null,
            ...(typeof d.id === 'number' ? { checkRunId: d.id } : {}),
            workflowRunId: parseActionsRunId(d.details_url || d.html_url || null)
          }))
        }
      } catch (err) {
        // Why: a PR can outlive the cached head SHA after force-pushes or remote
        // rewrites. Falling back to `gh pr checks` keeps the panel populated
        // instead of rendering a false "no checks" state from a stale commit.
        console.warn('getPRChecks via head SHA failed, falling back to gh pr checks:', err)
      } finally {
        release()
      }
    }
  }

  try {
    return await fallbackToPRChecks()
  } catch (err) {
    console.warn('getPRChecks failed:', err)
    throw err
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mapCheckAnnotations(raw: unknown): PRCheckRunDetails['annotations'] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .filter((annotation): annotation is Record<string, unknown> => Boolean(annotation))
    .map((annotation) => ({
      path: nullableString(annotation.path),
      startLine: nullableNumber(annotation.start_line),
      endLine: nullableNumber(annotation.end_line),
      annotationLevel: nullableString(annotation.annotation_level),
      title: nullableString(annotation.title),
      message: nullableString(annotation.message) ?? '',
      rawDetails: nullableString(annotation.raw_details)
    }))
}

function mapWorkflowJobs(raw: unknown, checkName?: string): PRCheckRunDetails['jobs'] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { jobs?: unknown }).jobs)) {
    return []
  }
  const jobs = (raw as { jobs: unknown[] }).jobs
    .filter((job): job is Record<string, unknown> => Boolean(job))
    .map((job) => ({
      id: nullableNumber(job.id),
      name: nullableString(job.name) ?? 'Unnamed job',
      status: nullableString(job.status),
      conclusion: nullableString(job.conclusion),
      startedAt: nullableString(job.started_at),
      completedAt: nullableString(job.completed_at),
      url: nullableString(job.html_url),
      logTail: null,
      steps: Array.isArray(job.steps)
        ? job.steps
            .filter((step): step is Record<string, unknown> => Boolean(step))
            .map((step) => ({
              name: nullableString(step.name) ?? 'Unnamed step',
              status: nullableString(step.status),
              conclusion: nullableString(step.conclusion),
              startedAt: nullableString(step.started_at),
              completedAt: nullableString(step.completed_at)
            }))
        : []
    }))
  const exactMatches = checkName ? jobs.filter((job) => job.name === checkName) : []
  return exactMatches.length > 0 ? exactMatches : jobs
}

function isCheckJobFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

function sliceCheckLogTail(logText: string): string {
  const lineTail = logText.split(/\r?\n/).slice(-PR_CHECK_LOG_TAIL_LINES).join('\n')
  const bytes = Buffer.from(lineTail, 'utf8')
  if (bytes.byteLength <= PR_CHECK_LOG_TAIL_BYTES) {
    return lineTail
  }
  return bytes.subarray(bytes.byteLength - PR_CHECK_LOG_TAIL_BYTES).toString('utf8')
}

function getCheckJobLogTailCacheKey(job: PRCheckRunDetails['jobs'][number]): string | null {
  if (job.id === null) {
    return null
  }
  return `${job.id}:${job.completedAt ?? ''}`
}

async function attachFailedJobLogTails(
  jobs: PRCheckRunDetails['jobs'],
  ownerRepo: OwnerRepo,
  ghOptions: GhExecOptions
): Promise<void> {
  const failedJobs = jobs
    .filter((job) => {
      const state = job.conclusion ?? job.status
      return job.id !== null && isCheckJobFailureState(state)
    })
    .slice(0, PR_CHECK_LOG_TAIL_JOB_LIMIT)

  // Why: failed workflows can have many jobs; cap log fetches so details remain
  // a lazy, bounded follow-up request instead of a burst of hosted log downloads.
  for (const job of failedJobs) {
    const cacheKey = getCheckJobLogTailCacheKey(job)
    if (!cacheKey) {
      continue
    }
    if (prCheckLogTailCache.has(cacheKey)) {
      job.logTail = prCheckLogTailCache.get(cacheKey) ?? null
      continue
    }
    try {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/jobs/${job.id}/logs`],
        ghOptions
      )
      job.logTail = sliceCheckLogTail(stdout)
    } catch (err) {
      console.warn('getPRCheckDetails workflow job log fetch failed:', err)
      job.logTail = null
    }
    setPrCheckLogTailCache(cacheKey, job.logTail)
  }
}

function getWorkflowRunIdFromCheckRun(
  checkRun: Record<string, unknown> | null
): number | undefined {
  const checkSuite = checkRun?.check_suite
  if (!checkSuite || typeof checkSuite !== 'object') {
    return undefined
  }
  const workflowRun = (checkSuite as { workflow_run?: unknown }).workflow_run
  if (!workflowRun || typeof workflowRun !== 'object') {
    return undefined
  }
  const id = (workflowRun as { id?: unknown }).id
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined
}

export async function getPRCheckDetails(
  repoPath: string,
  args: {
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: OwnerRepo | null
  },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckRunDetails | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = args.prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  if (!ownerRepo) {
    return null
  }

  await acquire()
  try {
    let checkRun: Record<string, unknown> | null = null
    let annotations: PRCheckRunDetails['annotations'] = []
    if (args.checkRunId) {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}`],
        ghOptions
      )
      checkRun = JSON.parse(stdout) as Record<string, unknown>
      try {
        const annotationsResult = await ghExecFileAsync(
          [
            'api',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}/annotations?per_page=20`
          ],
          ghOptions
        )
        annotations = mapCheckAnnotations(JSON.parse(annotationsResult.stdout))
      } catch (err) {
        console.warn('getPRCheckDetails annotations fetch failed:', err)
      }
    }

    const workflowRunId = args.workflowRunId ?? getWorkflowRunIdFromCheckRun(checkRun)
    let jobs: PRCheckRunDetails['jobs'] = []
    if (workflowRunId) {
      try {
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${workflowRunId}/jobs?per_page=100`
          ],
          ghOptions
        )
        jobs = mapWorkflowJobs(JSON.parse(stdout), args.checkName)
        await attachFailedJobLogTails(jobs, ownerRepo, ghOptions)
      } catch (err) {
        console.warn('getPRCheckDetails workflow jobs fetch failed:', err)
      }
    }

    const output =
      checkRun?.output && typeof checkRun.output === 'object'
        ? (checkRun.output as Record<string, unknown>)
        : null
    return {
      name: nullableString(checkRun?.name) ?? args.checkName ?? 'Check',
      status: nullableString(checkRun?.status),
      conclusion: nullableString(checkRun?.conclusion),
      url: nullableString(checkRun?.html_url) ?? args.url ?? null,
      detailsUrl: nullableString(checkRun?.details_url) ?? args.url ?? null,
      startedAt: nullableString(checkRun?.started_at),
      completedAt: nullableString(checkRun?.completed_at),
      title: nullableString(output?.title),
      summary: nullableString(output?.summary),
      text: nullableString(output?.text),
      annotations,
      jobs
    }
  } catch (err) {
    console.warn('getPRCheckDetails failed:', err)
    return null
  } finally {
    release()
  }
}

function parseActionsRunId(url: string | null | undefined): number | undefined {
  if (!url) {
    return undefined
  }
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url)
  if (!match) {
    return undefined
  }
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}

export async function rerunPRChecks(
  repoPath: string,
  prNumber: number,
  options: { headSha?: string; failedOnly?: boolean } = {},
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubRerunPRChecksResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId, localGitOptions)
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  const checks = await getPRChecks(
    repoPath,
    prNumber,
    options.headSha,
    ownerRepo,
    { noCache: true },
    connectionId,
    localGitOptions
  )
  const candidates = options.failedOnly
    ? checks.filter((check) =>
        ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
      )
    : checks
  const workflowRunIds = new Set(
    candidates
      .map((check) => check.workflowRunId ?? parseActionsRunId(check.url))
      .filter((id): id is number => typeof id === 'number')
  )
  const checkRunIds = new Set(
    candidates
      .filter((check) => !check.workflowRunId && !parseActionsRunId(check.url))
      .map((check) => check.checkRunId)
      .filter((id): id is number => typeof id === 'number')
  )

  if (workflowRunIds.size === 0 && checkRunIds.size === 0) {
    return {
      ok: false,
      error: options.failedOnly
        ? 'No failed GitHub Actions checks to rerun.'
        : 'No rerunnable checks found.'
    }
  }

  let count = 0
  await acquire()
  try {
    for (const runId of workflowRunIds) {
      const endpoint = options.failedOnly
        ? `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun-failed-jobs`
        : `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun`
      await ghExecFileAsync(['api', '-X', 'POST', endpoint], {
        ...ghOptions,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' }
      })
      count += 1
    }
    for (const checkRunId of checkRunIds) {
      await ghExecFileAsync(
        [
          'api',
          '-X',
          'POST',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${checkRunId}/rerequest`
        ],
        { ...ghOptions, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }
      )
      count += 1
    }
    return { ok: true, count }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyGhError(message).message }
  } finally {
    release()
  }
}

// Why: review thread resolution status and thread IDs are only available via
// GraphQL. The REST pulls/{n}/comments endpoint does not expose them, so we
// use GraphQL for review threads and REST for issue-level comments.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              databaseId
              author { __typename login avatarUrl(size: 48) }
              body
              createdAt
              url
              path
              reactionGroups {
                content
                reactors {
                  totalCount
                }
              }
            }
          }
        }
      }
      comments(first: 100) {
        nodes {
          databaseId
          author { __typename login avatarUrl(size: 48) }
          body
          createdAt
          url
          reactionGroups {
            content
            reactors {
              totalCount
            }
          }
        }
      }
    }
  }
}`

/**
 * Get all comments on a PR — both top-level conversation comments and inline
 * review comments (including suggestions). Uses GraphQL for review threads
 * to get resolution status, REST for issue-level comments.
 */
export async function getPRComments(
  repoPath: string,
  prNumber: number,
  options?: { noCache?: boolean; prRepo?: OwnerRepo | null },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRComment[]> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = options?.prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  if (ownerRepo) {
    await assertRateLimitBudget('core')
  }
  await acquire()
  try {
    if (ownerRepo) {
      // Why: --cache 60s saves rate-limit budget during normal loads, but when the
      // user explicitly clicks refresh we must skip it so gh fetches fresh data.
      const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
      const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`

      // Why: use allSettled so a single failing endpoint (e.g. GraphQL
      // permissions, transient network error) doesn't blank out all comments.
      // Each source is parsed independently; failed sources contribute zero
      // comments instead of aborting the entire fetch.
      const reviewThreadsGuard = rateLimitGuard('graphql')
      let reviewThreadsFetch: Promise<{ stdout: string; stderr: string } | null>
      if (reviewThreadsGuard.blocked) {
        reviewThreadsFetch = Promise.resolve(null)
      } else {
        noteRateLimitSpend('graphql')
        reviewThreadsFetch = ghExecFileAsync(
          [
            'api',
            'graphql',
            '-f',
            `query=${REVIEW_THREADS_QUERY}`,
            '-f',
            `owner=${ownerRepo.owner}`,
            '-f',
            `repo=${ownerRepo.repo}`,
            '-F',
            `pr=${prNumber}`
          ],
          ghOptions
        )
      }
      const [issueResult, threadsResult, reviewsResult] = await Promise.allSettled([
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/issues/${prNumber}/comments?per_page=100`],
          ghOptions
        ),
        reviewThreadsFetch,
        // Why: review summaries (approve, request changes, general comments) live
        // under pulls/{n}/reviews, not under issue comments or review threads.
        // Without this, a reviewer who submits "LGTM" without inline threads
        // would have their comment silently dropped from the panel.
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/pulls/${prNumber}/reviews?per_page=100`],
          ghOptions
        )
      ])
      noteRateLimitSpend('core', 2)

      // Parse issue comments (REST)
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        created_at: string
        html_url: string
      }
      let issueComments: PRComment[] = []
      if (issueResult.status === 'fulfilled') {
        issueComments = (JSON.parse(issueResult.value.stdout) as RESTComment[]).map(
          (c): PRComment => ({
            id: c.id,
            author: c.user?.login ?? 'ghost',
            authorAvatarUrl: c.user?.avatar_url ?? '',
            body: c.body ?? '',
            createdAt: c.created_at,
            url: c.html_url,
            isBot: c.user?.type === 'Bot'
          })
        )
      } else {
        console.warn('Failed to fetch issue comments:', issueResult.reason)
      }

      // Parse review threads (GraphQL)
      type GQLThread = {
        id: string
        isResolved: boolean
        line: number | null
        startLine: number | null
        originalLine: number | null
        originalStartLine: number | null
        comments: {
          nodes: {
            databaseId: number
            author: { __typename?: string; login: string; avatarUrl: string } | null
            body: string
            createdAt: string
            url: string
            path: string
            reactionGroups?: GitHubGraphQLReactionGroup[] | null
          }[]
        }
      }
      type GQLIssueComment = {
        databaseId: number
        author: { __typename?: string; login: string; avatarUrl: string } | null
        body: string
        createdAt: string
        url: string
        reactionGroups?: GitHubGraphQLReactionGroup[] | null
      }
      const reviewComments: PRComment[] = []
      if (threadsResult.status === 'fulfilled' && threadsResult.value) {
        const threadsData = JSON.parse(threadsResult.value.stdout) as {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: GQLThread[] }
                comments?: { nodes: GQLIssueComment[] }
              }
            }
          }
        }
        const pullRequest = threadsData.data.repository.pullRequest
        const graphQLIssueComments = (pullRequest.comments?.nodes ?? []).map(
          (c): PRComment => ({
            id: c.databaseId,
            author: c.author?.login ?? 'ghost',
            authorAvatarUrl: c.author?.avatarUrl ?? '',
            body: c.body ?? '',
            createdAt: c.createdAt,
            url: c.url,
            isBot: c.author?.__typename === 'Bot',
            reactions: mapGraphQLReactionGroups(c.reactionGroups)
          })
        )
        if (graphQLIssueComments.length > 0) {
          issueComments = graphQLIssueComments
        }

        const threads = pullRequest.reviewThreads.nodes
        for (const thread of threads) {
          for (const c of thread.comments.nodes) {
            reviewComments.push({
              id: c.databaseId,
              author: c.author?.login ?? 'ghost',
              authorAvatarUrl: c.author?.avatarUrl ?? '',
              body: c.body ?? '',
              createdAt: c.createdAt,
              url: c.url,
              isBot: c.author?.__typename === 'Bot',
              reactions: mapGraphQLReactionGroups(c.reactionGroups),
              path: c.path,
              threadId: thread.id,
              isResolved: thread.isResolved,
              isOutdated: thread.line == null,
              // Why: GitHub nulls out line/startLine when the commented code is
              // outdated (e.g. after a force-push). Fall back to originalLine which
              // always preserves the line numbers from when the comment was created.
              line: thread.line ?? thread.originalLine ?? undefined,
              startLine: thread.startLine ?? thread.originalStartLine ?? undefined
            })
          }
        }
      } else {
        if (threadsResult.status === 'rejected') {
          console.warn('Failed to fetch review threads:', threadsResult.reason)
        }
      }

      // Parse review summaries (REST) — only include reviews with a body,
      // since empty-body reviews (e.g. approvals with no comment) add noise.
      type RESTReview = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        state: string
        submitted_at: string
        html_url: string
      }
      let reviewSummaries: PRComment[] = []
      if (reviewsResult.status === 'fulfilled') {
        reviewSummaries = (JSON.parse(reviewsResult.value.stdout) as RESTReview[])
          .filter((r) => r.body?.trim())
          .map(
            (r): PRComment => ({
              id: r.id,
              author: r.user?.login ?? 'ghost',
              authorAvatarUrl: r.user?.avatar_url ?? '',
              body: r.body,
              createdAt: r.submitted_at,
              url: r.html_url,
              isBot: r.user?.type === 'Bot'
            })
          )
      } else {
        console.warn('Failed to fetch review summaries:', reviewsResult.reason)
      }

      const all = [...issueComments, ...reviewComments, ...reviewSummaries]
      all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return all
    }

    // Fallback: non-GitHub remote — use gh pr view (only returns issue-level comments)
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      ghOptions
    )
    noteRateLimitSpend('graphql')
    const data = JSON.parse(stdout) as {
      comments: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
      }[]
    }
    return (data.comments ?? []).map((c, i) => ({
      id: i,
      author: c.author?.login ?? 'ghost',
      authorAvatarUrl: '',
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url ?? ''
    }))
  } catch (err) {
    console.warn('getPRComments failed:', err)
    return []
  } finally {
    release()
  }
}

/**
 * Mark or unmark a PR file as viewed via GitHub's GraphQL API.
 */
export async function setPRFileViewed(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  pullRequestId: string
  path: string
  viewed: boolean
}): Promise<boolean> {
  const ghOptions = ghRepoExecOptions(
    githubRepoContext(args.repoPath, args.connectionId, args.localGitOptions)
  )
  const mutation = args.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const query = `mutation($pullRequestId: ID!, $path: String!) {
    ${mutation}(input: { pullRequestId: $pullRequestId, path: $path }) {
      pullRequest { id }
    }
  }`
  await acquire()
  try {
    await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `pullRequestId=${args.pullRequestId}`,
        '-f',
        `path=${args.path}`
      ],
      ghOptions
    )
    return true
  } catch (err) {
    console.warn(`${mutation} failed:`, err)
    return false
  } finally {
    release()
  }
}

/**
 * Resolve or unresolve a PR review thread via GraphQL.
 */
export async function resolveReviewThread(
  repoPath: string,
  threadId: string,
  resolve: boolean,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  const mutation = resolve ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { isResolved } } }`
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    console.warn(
      `${mutation} skipped: GitHub GraphQL rate limit nearly exhausted (${guard.remaining}/${guard.limit})`
    )
    return false
  }
  await acquire()
  try {
    noteRateLimitSpend('graphql')
    await ghExecFileAsync(
      ['api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`],
      ghOptions
    )
    return true
  } catch (err) {
    console.warn(`${mutation} failed:`, err)
    return false
  } finally {
    release()
  }
}

function mapReviewCommentResponse(
  data: {
    id?: number
    user: { login: string; avatar_url: string; type?: string } | null
    body?: string
    created_at?: string
    html_url?: string
    path?: string
    line?: number | null
  },
  body: string,
  path?: string,
  line?: number,
  startLine?: number,
  threadId?: string
): PRComment {
  return {
    id: data.id ?? Date.now(),
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? body,
    createdAt: data.created_at ?? new Date().toISOString(),
    url: data.html_url ?? '',
    isBot: data.user?.type === 'Bot',
    path: data.path ?? path,
    line: data.line ?? line,
    startLine,
    threadId
  }
}

export async function addPRReviewCommentReply(
  repoPath: string,
  prNumber: number,
  commentId: number,
  body: string,
  threadId?: string,
  path?: string,
  line?: number,
  connectionId?: string | null,
  prRepo?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubCommentResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '-X',
        'POST',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/comments/${commentId}/replies`,
        '--raw-field',
        `body=${body}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as Parameters<typeof mapReviewCommentResponse>[0]
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    return {
      ok: true,
      comment: mapReviewCommentResponse(data, body, path, line, undefined, threadId)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

export async function addPRReviewComment(
  args: GitHubPRReviewCommentInput & {
    connectionId?: string | null
    localGitOptions?: LocalGitExecOptions
  }
): Promise<GitHubCommentResult> {
  const ghOptions = ghRepoExecOptions(
    githubRepoContext(args.repoPath, args.connectionId, args.localGitOptions)
  )
  const ownerRepo = await getOwnerRepo(args.repoPath, args.connectionId, args.localGitOptions)
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const fields = [
      'api',
      '-X',
      'POST',
      `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${args.prNumber}/comments`,
      '--raw-field',
      `body=${args.body}`,
      '--raw-field',
      `commit_id=${args.commitId}`,
      '--raw-field',
      `path=${args.path}`,
      '--field',
      `line=${String(args.line)}`,
      '--raw-field',
      'side=RIGHT'
    ]
    if (typeof args.startLine === 'number' && args.startLine !== args.line) {
      fields.push(
        '--field',
        `start_line=${String(args.startLine)}`,
        '--raw-field',
        'start_side=RIGHT'
      )
    }
    const { stdout } = await ghExecFileAsync(fields, ghOptions)
    return {
      ok: true,
      comment: mapReviewCommentResponse(
        JSON.parse(stdout),
        args.body,
        args.path,
        args.line,
        args.startLine
      )
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

/**
 * Merge a PR by number using gh CLI.
 * method: 'merge' | 'squash' | 'rebase' (default: 'squash')
 */
export async function mergePR(
  repoPath: string,
  prNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  connectionId?: string | null,
  prRepo?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  await acquire()
  try {
    const mergeBlocker = await getPRMergeBlocker(
      repoPath,
      prNumber,
      ownerRepo,
      ghOptions,
      connectionId,
      localGitOptions
    )
    if (mergeBlocker) {
      return { ok: false, error: mergeBlocker }
    }

    // Don't use --delete-branch: it tries to delete the local branch which
    // fails when the user's worktree is checked out on it. Branch cleanup
    // is handled by worktree deletion (local) and GitHub's auto-delete setting (remote).
    const args = ['pr', 'merge', String(prNumber), `--${method}`]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function setPRAutoMerge(
  repoPath: string,
  prNumber: number,
  enabled: boolean,
  method: GitHubPRMergeMethod = 'squash',
  connectionId?: string | null,
  prRepo?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  await acquire()
  try {
    const args = ['pr', 'merge', String(prNumber), enabled ? '--auto' : '--disable-auto']
    if (enabled) {
      args.push(`--${method}`)
    }
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyGhError(message).message }
  } finally {
    release()
  }
}

async function getPRMergeBlocker(
  repoPath: string,
  prNumber: number,
  ownerRepo: OwnerRepo | null,
  ghOptions: GhExecOptions,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  if (!ownerRepo) {
    return null
  }

  try {
    const pr = await getPRByNumber(ownerRepo, prNumber, ghOptions)
    if (!pr) {
      return null
    }
    if (pr.reviewDecision === 'REVIEW_REQUIRED') {
      return 'This pull request requires review approval before it can be merged.'
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      return 'This pull request has requested changes and cannot be merged yet.'
    }
    if (pr.mergeQueueRequired === true) {
      return 'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.'
    }
    // Why: conflict summaries shell out to local git; SSH repo paths are remote-only
    // until that helper is routed through the SSH git provider.
    if (
      connectionId ||
      pr.mergeable !== 'CONFLICTING' ||
      !pr.baseRefName ||
      !pr.baseRefOid ||
      !pr.headRefOid
    ) {
      return null
    }

    const summary = await getPRConflictSummary(
      repoPath,
      pr.baseRefName,
      pr.baseRefOid,
      pr.headRefOid,
      localGitOptions
    )
    return formatMergeConflictBlocker(pr.baseRefName, summary)
  } catch {
    // Why: conflict preflight should improve stale UI diagnostics, not make
    // merge impossible when the lookup endpoint has a transient failure.
    return null
  }
}

function formatMergeConflictBlocker(
  baseRefName: string,
  summary: PRConflictSummary | undefined
): string {
  const heading = 'This pull request has merge conflicts and cannot be merged yet.'
  if (!summary || summary.files.length === 0) {
    return `${heading}\nUpdate the branch with ${baseRefName} and resolve the conflicts before merging.`
  }

  const files = summary.files.map((file) => `- ${file}`).join('\n')
  const behind = `${summary.commitsBehind} commit${summary.commitsBehind === 1 ? '' : 's'} behind ${baseRefName}`
  return `${heading}\n${behind} (base commit: ${summary.baseCommit}).\n\nConflicting files:\n${files}`
}

export async function updatePRState(
  repoPath: string,
  prNumber: number,
  updates: GitHubPullRequestStateUpdate,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)
  const ownerRepo = await getOwnerRepo(repoPath, connectionId, localGitOptions)
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  await acquire()
  try {
    const cmd = updates.state === 'closed' ? 'close' : 'reopen'
    // Why: GitHub can reject REST pull state PATCHes for reopen paths with a
    // generic 422; gh's PR commands use GitHub's supported reopen flow.
    await ghExecFileAsync(
      ['pr', cmd, String(prNumber), '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`],
      {
        ...ghOptions
      }
    )
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyGhError(message).message }
  } finally {
    release()
  }
}

export async function requestPRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return { ok: false, error: 'Enter at least one reviewer' }
  }
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId, localGitOptions)
  await acquire()
  try {
    const args = ['pr', 'edit', String(prNumber), '--add-reviewer', logins.join(',')]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function removePRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return { ok: false, error: 'Enter at least one reviewer' }
  }
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId, localGitOptions)
  await acquire()
  try {
    const args = ['pr', 'edit', String(prNumber), '--remove-reviewer', logins.join(',')]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}

/**
 * Update a PR's title.
 */
export async function updatePRTitle(
  repoPath: string,
  prNumber: number,
  title: string,
  connectionId?: string | null,
  prRepo?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  await acquire()
  try {
    const args = ['pr', 'edit', String(prNumber), '--title', title]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions
    })
    return true
  } catch (err) {
    console.warn('updatePRTitle failed:', err)
    return false
  } finally {
    release()
  }
}

export async function updatePRDetails(
  repoPath: string,
  prNumber: number,
  updates: { title?: string; body?: string },
  connectionId?: string | null,
  prRepo?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const ownerRepo = prRepo ?? (await getOwnerRepo(repoPath, connectionId, localGitOptions))
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  const fields: string[] = []
  if (updates.title !== undefined) {
    const title = updates.title.trim()
    if (!title) {
      return { ok: false, error: 'Title is required' }
    }
    fields.push(`title=${title}`)
  }
  if (updates.body !== undefined) {
    fields.push(`body=${updates.body}`)
  }
  if (fields.length === 0) {
    return { ok: true }
  }

  await acquire()
  try {
    await ghExecFileAsync(
      [
        'api',
        '-X',
        'PATCH',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`,
        ...fields.flatMap((field) => ['--raw-field', field])
      ],
      ghOptions
    )
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyGhError(message).message }
  } finally {
    release()
  }
}
