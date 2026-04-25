/* eslint-disable max-lines -- Why: co-locating all GitHub client functions keeps the
concurrency acquire/release pattern and error handling consistent across operations. */
import type {
  PRInfo,
  PRMergeableState,
  PRCheckDetail,
  PRComment,
  GitHubViewer,
  GitHubWorkItem
} from '../../shared/types'
import { parseTaskQuery, type ParsedTaskQuery } from '../../shared/task-query'
import { sortWorkItemsByUpdatedAt } from '../../shared/work-items'
import { getPRConflictSummary } from './conflict-summary'
import { execFileAsync, ghExecFileAsync, acquire, release, getOwnerRepo } from './gh-utils'
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

function buildWorkItemListArgs(args: {
  kind: 'issue' | 'pr'
  ownerRepo: { owner: string; repo: string } | null
  limit: number
  query: ParsedTaskQuery
}): string[] {
  const { kind, ownerRepo, limit, query } = args
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
  if (
    kind === 'pr' &&
    query.scope === 'pr' &&
    query.state === 'open' &&
    query.freeText === '' &&
    !query.reviewRequested &&
    !query.reviewedBy
  ) {
    out.push('--draft')
  }

  // review-requested and reviewed-by are not supported as standalone gh CLI flags,
  // so they must be passed as GitHub search qualifiers via --search.
  const searchParts: string[] = []
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

async function listRecentWorkItems(
  repoPath: string,
  ownerRepo: { owner: string; repo: string } | null,
  limit: number
): Promise<MainWorkItem[]> {
  if (ownerRepo) {
    const [issuesResult, prsResult] = await Promise.all([
      ghExecFileAsync(
        [
          'api',
          '--cache',
          '120s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
        ],
        { cwd: repoPath }
      ),
      ghExecFileAsync(
        [
          'api',
          '--cache',
          '120s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls?per_page=${limit}&state=open&sort=updated&direction=desc`
        ],
        { cwd: repoPath }
      )
    ])

    const issues = (JSON.parse(issuesResult.stdout) as Record<string, unknown>[])
      // Why: the GitHub issues REST endpoint also returns pull requests with a
      // `pull_request` marker. The new-workspace task picker needs distinct
      // issue vs PR buckets, so drop PR-shaped issue rows here before merging.
      .filter((item) => !('pull_request' in item))
      .map(mapIssueWorkItem)

    const prs = (JSON.parse(prsResult.stdout) as Record<string, unknown>[]).map((item) =>
      mapPullRequestWorkItem(item, ownerRepo.owner)
    )

    return sortWorkItemsByUpdatedAt([...issues, ...prs]).slice(0, limit)
  }

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
      { cwd: repoPath }
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
      { cwd: repoPath }
    )
  ])

  const issues = (JSON.parse(issuesResult.stdout) as Record<string, unknown>[]).map(
    mapIssueWorkItem
  )
  const prs = (JSON.parse(prsResult.stdout) as Record<string, unknown>[]).map((item) =>
    mapPullRequestWorkItem(item, null)
  )

  return sortWorkItemsByUpdatedAt([...issues, ...prs]).slice(0, limit)
}

async function listQueriedWorkItems(
  repoPath: string,
  ownerRepo: { owner: string; repo: string } | null,
  query: ParsedTaskQuery,
  limit: number
): Promise<MainWorkItem[]> {
  const fetchers: Promise<MainWorkItem[]>[] = []
  const issueScope = query.scope !== 'pr'
  const prScope = query.scope !== 'issue'

  if (issueScope) {
    fetchers.push(
      (async () => {
        const args = buildWorkItemListArgs({ kind: 'issue', ownerRepo, limit, query })
        try {
          const { stdout } = await ghExecFileAsync(args, { cwd: repoPath })
          return (JSON.parse(stdout) as Record<string, unknown>[]).map(mapIssueWorkItem)
        } catch {
          return []
        }
      })()
    )
  }

  if (prScope) {
    fetchers.push(
      (async () => {
        const args = buildWorkItemListArgs({ kind: 'pr', ownerRepo, limit, query })
        try {
          const { stdout } = await ghExecFileAsync(args, { cwd: repoPath })
          return (JSON.parse(stdout) as Record<string, unknown>[]).map((item) =>
            mapPullRequestWorkItem(item, ownerRepo?.owner ?? null)
          )
        } catch {
          return []
        }
      })()
    )
  }

  const results = await Promise.all(fetchers)
  return sortWorkItemsByUpdatedAt(results.flat()).slice(0, limit)
}

export async function listWorkItems(
  repoPath: string,
  limit = 24,
  query?: string
): Promise<MainWorkItem[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
  const trimmedQuery = query?.trim() ?? ''
  await acquire()
  try {
    // Why: errors propagate to IPC so the renderer's cross-repo aggregator can
    // count this repo as failed and surface the partial-failure banner. A
    // catch-all here would make an auth/network failure indistinguishable from
    // an empty result and silently under-report per-repo failures.
    if (!trimmedQuery) {
      return await listRecentWorkItems(repoPath, ownerRepo, limit)
    }

    const parsedQuery = parseTaskQuery(trimmedQuery)
    return await listQueriedWorkItems(repoPath, ownerRepo, parsedQuery, limit)
  } finally {
    release()
  }
}

export async function getRepoSlug(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  return getOwnerRepo(repoPath)
}

export async function getWorkItem(repoPath: string, number: number): Promise<MainWorkItem | null> {
  await acquire()
  try {
    const ownerRepo = await getOwnerRepo(repoPath)
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${number}`],
        { cwd: repoPath }
      )
      const item = JSON.parse(stdout) as Record<string, unknown>
      if ('pull_request' in item) {
        const prResult = await ghExecFileAsync(
          ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`],
          { cwd: repoPath }
        )
        const pr = JSON.parse(prResult.stdout) as Record<string, unknown>
        const prHeadOwner = extractHeadOwnerLogin(pr)
        return {
          id: `pr:${String(pr.number)}`,
          type: 'pr',
          number: Number(pr.number),
          title: String(pr.title ?? ''),
          state:
            pr.state === 'closed'
              ? pr.merged_at
                ? 'merged'
                : 'closed'
              : pr.draft
                ? 'draft'
                : 'open',
          url: String(pr.html_url ?? pr.url ?? ''),
          labels: Array.isArray(pr.labels)
            ? pr.labels
                .map((label) =>
                  typeof label === 'object' && label !== null && 'name' in label
                    ? String((label as { name?: unknown }).name ?? '')
                    : ''
                )
                .filter(Boolean)
            : [],
          updatedAt: String(pr.updated_at ?? ''),
          author:
            typeof pr.user === 'object' && pr.user !== null && 'login' in pr.user
              ? String((pr.user as { login?: unknown }).login ?? '')
              : null,
          branchName:
            typeof pr.head === 'object' && pr.head !== null && 'ref' in pr.head
              ? String((pr.head as { ref?: unknown }).ref ?? '')
              : undefined,
          baseRefName:
            typeof pr.base === 'object' && pr.base !== null && 'ref' in pr.base
              ? String((pr.base as { ref?: unknown }).ref ?? '')
              : undefined,
          // Why: only emit isCrossRepository when we actually know the head
          // owner. Falsely claiming "not a fork" would let the picker try a
          // normal-PR fetch against a fork head and fail.
          ...(prHeadOwner !== null ? { isCrossRepository: prHeadOwner !== ownerRepo.owner } : {})
        }
      }

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
        updatedAt: String(item.updated_at ?? ''),
        author:
          typeof item.user === 'object' && item.user !== null && 'login' in item.user
            ? String((item.user as { login?: unknown }).login ?? '')
            : null
      }
    }

    try {
      const { stdout } = await ghExecFileAsync(
        [
          'issue',
          'view',
          String(number),
          '--json',
          'number,title,state,url,labels,updatedAt,author'
        ],
        { cwd: repoPath }
      )
      const item = JSON.parse(stdout) as Record<string, unknown>
      return {
        id: `issue:${String(item.number)}`,
        type: 'issue',
        number: Number(item.number),
        title: String(item.title ?? ''),
        state: String(item.state ?? 'open') === 'closed' ? 'closed' : 'open',
        url: String(item.url ?? ''),
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((label) =>
                typeof label === 'object' && label !== null && 'name' in label
                  ? String((label as { name?: unknown }).name ?? '')
                  : ''
              )
              .filter(Boolean)
          : [],
        updatedAt: String(item.updatedAt ?? ''),
        author:
          typeof item.author === 'object' && item.author !== null && 'login' in item.author
            ? String((item.author as { login?: unknown }).login ?? '')
            : null
      }
    } catch {
      const { stdout } = await ghExecFileAsync(
        [
          'pr',
          'view',
          String(number),
          '--json',
          'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner'
        ],
        { cwd: repoPath }
      )
      const item = JSON.parse(stdout) as Record<string, unknown>
      return {
        id: `pr:${String(item.number)}`,
        type: 'pr',
        number: Number(item.number),
        title: String(item.title ?? ''),
        state: item.isDraft ? 'draft' : String(item.state ?? 'open') === 'open' ? 'open' : 'closed',
        url: String(item.url ?? ''),
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((label) =>
                typeof label === 'object' && label !== null && 'name' in label
                  ? String((label as { name?: unknown }).name ?? '')
                  : ''
              )
              .filter(Boolean)
          : [],
        updatedAt: String(item.updatedAt ?? ''),
        author:
          typeof item.author === 'object' && item.author !== null && 'login' in item.author
            ? String((item.author as { login?: unknown }).login ?? '')
            : null,
        branchName: String(item.headRefName ?? ''),
        baseRefName: String(item.baseRefName ?? '')
        // Why: ownerRepo is null on this path so we can't compare head vs base
        // owners. Leave isCrossRepository undefined rather than guessing —
        // falsely claiming "not a fork" would let the picker try a normal-PR
        // fetch against a fork head and fail.
      }
    }
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 */
export async function getPRForBranch(repoPath: string, branch: string): Promise<PRInfo | null> {
  // Strip refs/heads/ prefix if present
  const branchName = branch.replace(/^refs\/heads\//, '')

  // During a rebase the worktree is in detached HEAD and branch is empty.
  // An empty --head filter causes gh to return an arbitrary PR — bail early.
  if (!branchName) {
    return null
  }

  await acquire()
  try {
    const ownerRepo = await getOwnerRepo(repoPath)
    let data: {
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
    } | null = null

    if (ownerRepo) {
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
          'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
        ],
        { cwd: repoPath }
      )
      const list = JSON.parse(stdout) as NonNullable<typeof data>[]
      data = list[0] ?? null
    } else {
      const { stdout } = await ghExecFileAsync(
        [
          'pr',
          'view',
          branchName,
          '--json',
          'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
        ],
        { cwd: repoPath }
      )
      data = JSON.parse(stdout)
    }

    if (!data) {
      return null
    }

    const conflictSummary =
      data.mergeable === 'CONFLICTING' && data.baseRefName && data.baseRefOid && data.headRefOid
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
  options?: { noCache?: boolean }
): Promise<PRCheckDetail[]> {
  const ownerRepo = headSha ? await getOwnerRepo(repoPath) : null
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
          { cwd: repoPath }
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
    const { stdout } = await ghExecFileAsync(
      ['pr', 'checks', String(prNumber), '--json', 'name,state,link'],
      { cwd: repoPath }
    )
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
              author { login avatarUrl(size: 48) }
              body
              createdAt
              url
              path
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
  options?: { noCache?: boolean }
): Promise<PRComment[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
      const [issueResult, threadsResult, reviewsResult] = await Promise.allSettled([
        execFileAsync(
          'gh',
          ['api', ...cacheArgs, `${base}/issues/${prNumber}/comments?per_page=100`],
          { cwd: repoPath, encoding: 'utf-8' }
        ),
        execFileAsync(
          'gh',
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
          { cwd: repoPath, encoding: 'utf-8' }
        ),
        // Why: review summaries (approve, request changes, general comments) live
        // under pulls/{n}/reviews, not under issue comments or review threads.
        // Without this, a reviewer who submits "LGTM" without inline threads
        // would have their comment silently dropped from the panel.
        execFileAsync(
          'gh',
          ['api', ...cacheArgs, `${base}/pulls/${prNumber}/reviews?per_page=100`],
          { cwd: repoPath, encoding: 'utf-8' }
        )
      ])

      // Parse issue comments (REST)
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string } | null
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
            url: c.html_url
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
            author: { login: string; avatarUrl: string } | null
            body: string
            createdAt: string
            url: string
            path: string
          }[]
        }
      }
      const reviewComments: PRComment[] = []
      if (threadsResult.status === 'fulfilled') {
        const threadsData = JSON.parse(threadsResult.value.stdout) as {
          data: { repository: { pullRequest: { reviewThreads: { nodes: GQLThread[] } } } }
        }
        const threads = threadsData.data.repository.pullRequest.reviewThreads.nodes
        for (const thread of threads) {
          for (const c of thread.comments.nodes) {
            reviewComments.push({
              id: c.databaseId,
              author: c.author?.login ?? 'ghost',
              authorAvatarUrl: c.author?.avatarUrl ?? '',
              body: c.body ?? '',
              createdAt: c.createdAt,
              url: c.url,
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
        console.warn('Failed to fetch review threads:', threadsResult.reason)
      }

      // Parse review summaries (REST) — only include reviews with a body,
      // since empty-body reviews (e.g. approvals with no comment) add noise.
      type RESTReview = {
        id: number
        user: { login: string; avatar_url: string } | null
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
              url: r.html_url
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
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      { cwd: repoPath, encoding: 'utf-8' }
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
  resolve: boolean
): Promise<boolean> {
  const mutation = resolve ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { isResolved } } }`
  await acquire()
  try {
    await execFileAsync(
      'gh',
      ['api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`],
      { cwd: repoPath, encoding: 'utf-8' }
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
 * Merge a PR by number using gh CLI.
 * method: 'merge' | 'squash' | 'rebase' (default: 'squash')
 */
export async function mergePR(
  repoPath: string,
  prNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash'
): Promise<{ ok: true } | { ok: false; error: string }> {
  await acquire()
  try {
    // Don't use --delete-branch: it tries to delete the local branch which
    // fails when the user's worktree is checked out on it. Branch cleanup
    // is handled by worktree deletion (local) and GitHub's auto-delete setting (remote).
    await ghExecFileAsync(['pr', 'merge', String(prNumber), `--${method}`], {
      cwd: repoPath,
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
  title: string
): Promise<boolean> {
  await acquire()
  try {
    await ghExecFileAsync(['pr', 'edit', String(prNumber), '--title', title], {
      cwd: repoPath
    })
    return true
  } catch (err) {
    console.warn('updatePRTitle failed:', err)
    return false
  } finally {
    release()
  }
}
