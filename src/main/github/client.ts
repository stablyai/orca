/* eslint-disable max-lines -- Why: co-locating all GitHub client functions keeps the
concurrency acquire/release pattern and error handling consistent across operations. */
import type {
  ClassifiedError,
  GitPushTarget,
  IssueSourcePreference,
  ListWorkItemsResult,
  PRInfo,
  PRMergeableState,
  PRCheckDetail,
  GitHubCommentResult,
  GitHubPRReviewCommentInput,
  PRComment,
  GitHubViewer,
  GitHubWorkItem
} from '../../shared/types'
import type { CreateHostedReviewInput, CreateHostedReviewResult } from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { parseTaskQuery, type ParsedTaskQuery } from '../../shared/task-query'
import { sortWorkItemsByUpdatedAt } from '../../shared/work-items'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getPRConflictSummary } from './conflict-summary'
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
  resolveIssueSource,
  classifyGhError,
  classifyListIssuesError,
  ghRepoExecOptions,
  githubRepoContext,
  getRemoteUrlForRepo,
  type OwnerRepo
} from './gh-utils'
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
import { noteRateLimitSpend, rateLimitGuard } from './rate-limit'

const ORCA_REPO = 'stablyai/orca'

/**
 * Check if the authenticated user has starred the Orca repo.
 * Returns true if starred, false if not, null if unable to determine (gh unavailable).
 */
export async function checkOrcaStarred(): Promise<boolean | null> {
  await acquire()
  try {
    await execFileAsync('gh', ['api', `user/starred/${ORCA_REPO}`], { encoding: 'utf-8' })
    return true
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

export async function getPullRequestPushTarget(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null
): Promise<GitPushTarget | null> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
  if (!ownerRepo) {
    return null
  }

  await acquire()
  try {
    const [{ stdout: prStdout }, origin] = await Promise.all([
      ghExecFileAsync(['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}`], {
        ...ghOptions
      }),
      getOwnerRepoForRemote(repoPath, 'origin', connectionId)
    ])
    const pr = JSON.parse(prStdout) as {
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
    if (!owner || !repo || !branchName || !cloneUrl || !sshUrl) {
      return null
    }
    if (
      origin &&
      origin.owner.toLowerCase() === owner.toLowerCase() &&
      origin.repo.toLowerCase() === repo.toLowerCase()
    ) {
      return { remoteName: 'origin', branchName }
    }

    let originUrl: string | null = null
    try {
      const rawOriginUrl = connectionId
        ? await getRemoteUrlForRepo(context, 'origin')
        : (await gitExecFileAsync(['remote', 'get-url', 'origin'], { cwd: repoPath })).stdout
      originUrl = rawOriginUrl?.trim() || null
    } catch {
      originUrl = null
    }
    return {
      remoteName: sanitizeRemoteName(owner, repo),
      branchName,
      remoteUrl: pickPushRemoteUrl({ originUrl, cloneUrl, sshUrl })
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
          : null
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
    const repo = (item.head as { repo?: unknown }).repo
    if (typeof repo === 'object' && repo !== null) {
      const owner = (repo as { owner?: unknown }).owner
      if (typeof owner === 'object' && owner !== null) {
        const login = (owner as { login?: unknown }).login
        if (typeof login === 'string' && login.trim()) {
          return login
        }
      }
    }
  }
  return null
}

function mapPullRequestWorkItem(
  item: Record<string, unknown>,
  baseOwnerLogin: string | null = null
): MainWorkItem {
  // Why: fork PRs are disabled in the Start-from picker. We compare the PR head's
  // owner to the selected repo's owner; when baseOwnerLogin is unknown we default
  // to false so non-picker call sites see the same shape as before.
  const headOwnerLogin = extractHeadOwnerLogin(item)
  // Why: only emit isCrossRepository when we actually know the head owner. If
  // the gh response lacks `headRepositoryOwner` (older callers, tests without
  // that fixture, or gh not returning it), leave the field undefined instead
  // of falsely claiming "not a fork".
  const isCrossRepository =
    headOwnerLogin !== null && baseOwnerLogin !== null ? headOwnerLogin !== baseOwnerLogin : null
  return {
    id: `pr:${String(item.number)}`,
    type: 'pr',
    number: Number(item.number),
    title: String(item.title ?? ''),
    state:
      item.state === 'closed'
        ? item.merged_at || item.mergedAt
          ? 'merged'
          : 'closed'
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
    ...(isCrossRepository !== null ? { isCrossRepository } : {})
  }
}

async function fetchIssueWorkItem(
  repoPath: string,
  ownerRepo: OwnerRepo | null,
  number: number,
  connectionId?: string | null
): Promise<MainWorkItem | null> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
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
  connectionId?: string | null
): Promise<MainWorkItem> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  if (ownerRepo) {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
      ghOptions
    )
    return mapPullRequestWorkItem(JSON.parse(stdout) as Record<string, unknown>, ownerRepo.owner)
  }

  const { stdout } = await ghExecFileAsync(
    [
      'pr',
      'view',
      String(number),
      '--json',
      'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner'
    ],
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
  const fields =
    kind === 'issue'
      ? 'number,title,state,url,labels,updatedAt,author'
      : 'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner'
  const command = kind === 'issue' ? ['issue', 'list'] : ['pr', 'list']
  const out = [...command, '--limit', String(limit), '--json', fields]

  if (ownerRepo) {
    out.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
  }

  const state = query.state
  if (state && !(kind === 'issue' && state === 'merged')) {
    out.push('--state', state === 'all' ? 'all' : state)
  }

  if (kind === 'pr' && query.state === 'merged') {
    out.push('--state', 'merged')
  }

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

async function listRecentWorkItems(
  repoPath: string,
  issueOwnerRepo: OwnerRepo | null,
  prOwnerRepo: OwnerRepo | null,
  limit: number,
  connectionId?: string | null
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  if (issueOwnerRepo || prOwnerRepo) {
    // Why: allSettled so a 403 on upstream issues doesn't zero out the origin
    // PR half — the UI renders partial results plus a banner for the failing
    // side, matching the parent design doc's partial-failure rule (§2).
    const [issuesSettled, prsSettled] = await Promise.allSettled([
      issueOwnerRepo
        ? ghExecFileAsync(
            [
              'api',
              '--cache',
              '120s',
              `repos/${issueOwnerRepo.owner}/${issueOwnerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
            ],
            ghOptions
          )
        : ghExecFileAsync(
            [
              'issue',
              'list',
              '--limit',
              String(limit),
              '--state',
              'open',
              '--json',
              'number,title,state,url,labels,updatedAt,author'
            ],
            ghOptions
          ),
      prOwnerRepo
        ? ghExecFileAsync(
            [
              'api',
              '--cache',
              '120s',
              `repos/${prOwnerRepo.owner}/${prOwnerRepo.repo}/pulls?per_page=${limit}&state=open&sort=updated&direction=desc`
            ],
            ghOptions
          )
        : ghExecFileAsync(
            [
              'pr',
              'list',
              '--limit',
              String(limit),
              '--state',
              'open',
              '--json',
              'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner'
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
        mapPullRequestWorkItem(item, prOwnerRepo?.owner ?? null)
      )
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
        'number,title,state,url,labels,updatedAt,author'
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
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner'
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
  connectionId?: string | null
): Promise<PartialWorkItemsResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const issueScope = query.scope !== 'pr'
  const prScope = query.scope !== 'issue'

  // Why: run the issue and PR fetches in parallel but surface the
  // issue-side error separately so the IPC envelope can carry it up. PR-side
  // failures retain the prior swallow-and-log behavior per parent doc §6.
  const issueFetch = (async (): Promise<PartialWorkItemsResult> => {
    if (!issueScope) {
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
    const args = buildWorkItemListArgs({
      kind: 'pr',
      ownerRepo: prOwnerRepo,
      limit,
      query,
      before
    })
    try {
      const { stdout } = await ghExecFileAsync(args, ghOptions)
      return (JSON.parse(stdout) as Record<string, unknown>[]).map((item) =>
        mapPullRequestWorkItem(item, prOwnerRepo?.owner ?? null)
      )
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
  connectionId?: string | null
): Promise<ListWorkItemsResult<MainWorkItem>> {
  // Why: resolve the raw upstream candidate alongside the preference-aware
  // issue source. The selector needs to know whether an upstream remote
  // *exists* to decide whether to render — independent of whether the user
  // has picked 'origin' (which would otherwise make `sources.issues` equal
  // origin and hide the selector permanently).
  const [issueResolved, prOwnerRepo, upstreamCandidate] = await Promise.all([
    resolveIssueSource(repoPath, preference, connectionId),
    getOwnerRepo(repoPath, connectionId),
    getOwnerRepoForRemote(repoPath, 'upstream', connectionId)
  ])
  const issueOwnerRepo = issueResolved.source
  const trimmedQuery = query?.trim() ?? ''
  await acquire()
  try {
    // Why: errors propagate to IPC so the renderer's cross-repo aggregator can
    // count this repo as failed and surface the partial-failure banner. A
    // catch-all here would make an auth/network failure indistinguishable from
    // an empty result and silently under-report per-repo failures.
    const partial = !trimmedQuery
      ? await listRecentWorkItems(repoPath, issueOwnerRepo, prOwnerRepo, limit, connectionId)
      : await listQueriedWorkItems(
          repoPath,
          issueOwnerRepo,
          prOwnerRepo,
          parseTaskQuery(trimmedQuery),
          limit,
          before,
          connectionId
        )

    const errors = partial.issuesError ? { issues: partial.issuesError } : undefined
    return {
      items: partial.items,
      sources: {
        issues: issueOwnerRepo,
        prs: prOwnerRepo,
        upstreamCandidate: upstreamCandidate ?? null
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
    parts.push('is:closed')
  } else if (query.state === 'merged') {
    parts.push('is:merged')
  }
  if (query.draft) {
    parts.push('draft:true')
  }
  if (query.assignee) {
    parts.push(`assignee:${query.assignee}`)
  }
  if (query.author) {
    parts.push(`author:${query.author}`)
  }
  if (query.reviewRequested) {
    parts.push(`review-requested:${query.reviewRequested}`)
  }
  if (query.reviewedBy) {
    parts.push(`reviewed-by:${query.reviewedBy}`)
  }
  for (const label of query.labels) {
    parts.push(`label:${label}`)
  }
  if (query.freeText) {
    parts.push(query.freeText)
  }
  return parts.join(' ')
}

async function countWorkItemsForQuery(
  repoPath: string,
  ownerRepo: OwnerRepo,
  query: ParsedTaskQuery,
  connectionId?: string | null
): Promise<number> {
  const searchQ = buildSearchQueryString(ownerRepo, query)
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
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
  connectionId?: string | null
): Promise<number> {
  const [issueResolved, prOwnerRepo] = await Promise.all([
    resolveIssueSource(repoPath, preference, connectionId),
    getOwnerRepo(repoPath, connectionId)
  ])
  const issueOwnerRepo = issueResolved.source
  const ownerRepo = prOwnerRepo ?? issueOwnerRepo
  if (!ownerRepo) {
    return 0
  }

  const trimmedQuery = query?.trim() ?? ''
  const parsedQuery = trimmedQuery ? parseTaskQuery(trimmedQuery) : null
  const effectiveQuery = parsedQuery ?? defaultOpenWorkItemQuery()

  await acquire()
  try {
    if (sameOwnerRepo(issueOwnerRepo, prOwnerRepo)) {
      return await countWorkItemsForQuery(repoPath, ownerRepo, effectiveQuery, connectionId)
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
          connectionId
        )
      )
    }
    if (effectiveQuery.scope !== 'issue' && prOwnerRepo) {
      counts.push(
        countWorkItemsForQuery(
          repoPath,
          prOwnerRepo,
          { ...effectiveQuery, scope: 'pr' },
          connectionId
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
  connectionId?: string | null
): Promise<{ owner: string; repo: string } | null> {
  return getOwnerRepo(repoPath, connectionId)
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
}): Promise<{ number: number; url: string } | null> {
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
    { cwd: args.repoPath }
  )
  const list = JSON.parse(stdout) as { number?: number; url?: string }[]
  if (list.length !== 1 || !list[0]?.number || !list[0]?.url) {
    return null
  }
  return { number: list[0].number, url: list[0].url }
}

export async function createGitHubPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'github') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  const ownerRepo = await getOwnerRepo(repoPath)
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
    await writeFile(bodyPath, input.body ?? '', 'utf8')
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
      const { stdout } = await ghExecFileAsync(createArgs, {
        cwd: repoPath,
        timeout: 60_000,
        idempotent: false
      })
      const created = parseCreatePRPayload(stdout)
      if (created) {
        return { ok: true, ...created }
      }
      const found = head
        ? await findOpenPRByHeadBase({ repoPath, ownerRepo, head, base }).catch(() => null)
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
        const existing = await findOpenPRByHeadBase({ repoPath, ownerRepo, head, base }).catch(
          () => null
        )
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
  connectionId?: string | null
): Promise<MainWorkItem | null> {
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueWorkItem(
        repoPath,
        await getIssueOwnerRepo(repoPath, connectionId),
        number,
        connectionId
      )
    }
    if (type === 'pr') {
      return await fetchPullRequestWorkItem(
        repoPath,
        await getOwnerRepo(repoPath, connectionId),
        number,
        connectionId
      )
    }

    try {
      const issue = await fetchIssueWorkItem(
        repoPath,
        await getIssueOwnerRepo(repoPath, connectionId),
        number,
        connectionId
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
      await getOwnerRepo(repoPath, connectionId),
      number,
      connectionId
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
  connectionId?: string | null
): Promise<MainWorkItem | null> {
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueWorkItem(repoPath, ownerRepo, number, connectionId)
    }
    return await fetchPullRequestWorkItem(repoPath, ownerRepo, number, connectionId)
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
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'

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

async function getRestPRForBranch(
  ownerRepo: OwnerRepo,
  branchName: string,
  ghOptions: ReturnType<typeof ghRepoExecOptions>
): Promise<PullRequestLookupData | null> {
  const head = encodeURIComponent(`${ownerRepo.owner}:${branchName}`)
  const { stdout } = await ghExecFileAsync(
    ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls?head=${head}&state=all&per_page=1`],
    ghOptions
  )
  const list = JSON.parse(stdout) as RestPullRequest[]
  const pr = list[0]
  return pr ? mapRestPullRequest(pr) : null
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

function isNotFoundGhError(err: unknown): boolean {
  const stderr = err instanceof Error ? err.message : String(err)
  return classifyGhError(stderr).type === 'not_found'
}

/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 *
 * When `linkedPRNumber` is provided and the branch lookup yields nothing,
 * falls back to looking up the PR by number. This handles "create from PR"
 * worktrees, whose branch is a fresh local branch (not the PR's head ref) —
 * the branch-keyed lookup misses, but the user still expects the linked PR
 * to surface on the worktree card.
 */
export async function getPRForBranch(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null
): Promise<PRInfo | null> {
  // Strip refs/heads/ prefix if present
  const branchName = branch.replace(/^refs\/heads\//, '')
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)

  await acquire()
  try {
    const ownerRepo = await getOwnerRepo(repoPath, connectionId)
    let data: PullRequestLookupData | null = null

    // During a rebase the worktree is in detached HEAD and branch is empty.
    // An empty --head filter causes gh to return an arbitrary PR — skip the
    // branch lookup and rely on the linkedPR fallback below if available.
    if (branchName) {
      if (ownerRepo) {
        try {
          const { stdout } = await ghExecFileAsync(
            [
              'pr',
              'list',
              '--repo',
              `${ownerRepo.owner}/${ownerRepo.repo}`,
              '--head',
              branchName,
              '--state',
              'all',
              '--limit',
              '1',
              '--json',
              PR_LOOKUP_JSON_FIELDS
            ],
            ghOptions
          )
          const list = JSON.parse(stdout) as PullRequestLookupData[]
          data = list[0] ?? null
        } catch (err) {
          // Why: `gh pr list/view` uses GraphQL and can hit that quota while
          // REST is still available. Falling back prevents a real PR from
          // rendering as "No pull request found" during GraphQL outages.
          if (!isNotFoundGhError(err)) {
            data = await getRestPRForBranch(ownerRepo, branchName, ghOptions)
          }
        }
      } else {
        const { stdout } = await ghExecFileAsync(
          ['pr', 'view', branchName, '--json', PR_LOOKUP_JSON_FIELDS],
          ghOptions
        )
        data = JSON.parse(stdout)
      }
    }

    if (!data && typeof linkedPRNumber === 'number') {
      const args = ownerRepo
        ? [
            'pr',
            'view',
            String(linkedPRNumber),
            '--repo',
            `${ownerRepo.owner}/${ownerRepo.repo}`,
            '--json',
            PR_LOOKUP_JSON_FIELDS
          ]
        : ['pr', 'view', String(linkedPRNumber), '--json', PR_LOOKUP_JSON_FIELDS]
      try {
        const { stdout } = await ghExecFileAsync(args, ghOptions)
        data = JSON.parse(stdout)
      } catch (err) {
        // Why: a stale linkedPRNumber (PR deleted, wrong repo, …) makes
        // `gh pr view <number>` reject. Treat that as the no-PR case so
        // callers see the historical `null` semantics instead of a thrown
        // error every poll cycle.
        data =
          ownerRepo && !isNotFoundGhError(err)
            ? await getRestPRByNumber(ownerRepo, linkedPRNumber, ghOptions)
            : null
      }
    }

    if (!data) {
      return null
    }

    const conflictSummary =
      !connectionId &&
      data.mergeable === 'CONFLICTING' &&
      data.baseRefName &&
      data.baseRefOid &&
      data.headRefOid
        ? await getPRConflictSummary(repoPath, data.baseRefName, data.baseRefOid, data.headRefOid)
        : undefined

    return {
      number: data.number,
      title: data.title,
      state: mapPRState(data.state, data.isDraft),
      url: data.url,
      checksStatus: deriveCheckStatus(data.statusCheckRollup),
      updatedAt: data.updatedAt,
      mergeable: (data.mergeable as PRMergeableState) ?? 'UNKNOWN',
      headSha: data.headRefOid,
      conflictSummary
    }
  } catch {
    return null
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
  options?: { noCache?: boolean },
  connectionId?: string | null
): Promise<PRCheckDetail[]> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
  await acquire()
  try {
    if (ownerRepo && headSha) {
      // Why: --cache 60s saves rate-limit budget during polling, but when the
      // user explicitly clicks refresh we must skip it so gh fetches fresh data.
      const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
      try {
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            ...cacheArgs,
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`
          ],
          ghOptions
        )
        const data = JSON.parse(stdout) as {
          check_runs: {
            name: string
            status: string
            conclusion: string | null
            html_url: string
            details_url: string | null
          }[]
        }
        return data.check_runs.map((d) => ({
          name: d.name,
          status: mapCheckRunRESTStatus(d.status),
          conclusion: mapCheckRunRESTConclusion(d.status, d.conclusion),
          url: d.details_url || d.html_url || null
        }))
      } catch (err) {
        // Why: a PR can outlive the cached head SHA after force-pushes or remote
        // rewrites. Falling back to `gh pr checks` keeps the panel populated
        // instead of rendering a false "no checks" state from a stale commit.
        console.warn('getPRChecks via head SHA failed, falling back to gh pr checks:', err)
      }
    }
    // Fallback: no branch provided or non-GitHub remote
    const fallbackArgs = ['pr', 'checks', String(prNumber), '--json', 'name,state,link']
    if (ownerRepo) {
      fallbackArgs.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    const { stdout } = await ghExecFileAsync(fallbackArgs, ghOptions)
    const data = JSON.parse(stdout) as { name: string; state: string; link: string }[]
    return data.map((d) => ({
      name: d.name,
      status: mapCheckStatus(d.state),
      conclusion: mapCheckConclusion(d.state),
      url: d.link || null
    }))
  } catch (err) {
    console.warn('getPRChecks failed:', err)
    return []
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
  options?: { noCache?: boolean },
  connectionId?: string | null
): Promise<PRComment[]> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
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
 * Resolve or unresolve a PR review thread via GraphQL.
 */
export async function resolveReviewThread(
  repoPath: string,
  threadId: string,
  resolve: boolean,
  connectionId?: string | null
): Promise<boolean> {
  const mutation = resolve ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { isResolved } } }`
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
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
  connectionId?: string | null
): Promise<GitHubCommentResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
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
    return {
      ok: true,
      comment: mapReviewCommentResponse(JSON.parse(stdout), body, path, line, undefined, threadId)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

export async function addPRReviewComment(
  args: GitHubPRReviewCommentInput & { connectionId?: string | null }
): Promise<GitHubCommentResult> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(args.repoPath, args.connectionId))
  const ownerRepo = await getOwnerRepo(args.repoPath, args.connectionId)
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
  connectionId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
  await acquire()
  try {
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

/**
 * Update a PR's title.
 */
export async function updatePRTitle(
  repoPath: string,
  prNumber: number,
  title: string,
  connectionId?: string | null
): Promise<boolean> {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId))
  const ownerRepo = await getOwnerRepo(repoPath, connectionId)
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
