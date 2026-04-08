/* eslint-disable max-lines -- Why: co-locating all GitHub client functions keeps the
concurrency acquire/release pattern and error handling consistent across operations. */
import type { PRInfo, PRMergeableState, PRCheckDetail, PRComment } from '../../shared/types'
import { getPRConflictSummary } from './conflict-summary'
import { execFileAsync, ghExecFileAsync, acquire, release, getOwnerRepo } from './gh-utils'
export { _resetOwnerRepoCache } from './gh-utils'
export { getIssue, listIssues } from './issues'
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
