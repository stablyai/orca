/* eslint-disable max-lines -- Why: co-locating issue list/create/update/
comment operations keeps the shared acquire/release + error-classification
pattern obvious. Each function is short; the file is long because the
surface is broad. */
import type {
  ClassifiedError,
  GitHubAssignableUser,
  GitHubCommentResult,
  GitHubIssueUpdate,
  IssueInfo,
  IssueSourcePreference,
  PRComment
} from '../../shared/types'
import { mapIssueInfo } from './mappers'
// prettier-ignore
import { ghExecFileAsync, acquire, release, getIssueOwnerRepo, resolveIssueSource, classifyGhError, classifyListIssuesError, ghRepoExecOptions, githubRepoContext } from './gh-utils'

// Why: distinguishes a successful-empty listing from a failed fetch. The
// previous `catch { return [] }` conflated a 403 on a private upstream with an
// empty backlog. Callers decide how to surface `error`.
//
// Why no `fellBack` here: the fell-back signal for the renderer toast rides on
// `ListWorkItemsResult.issueSourceFellBack` (the Tasks list's envelope). The
// only consumer of `listIssues` — the `gh:listIssues` IPC handler — unwraps
// to `.items` and has no UI hook to surface a fallback toast. Adding a dead
// `fellBack` field here invited drift between the JSDoc promise and reality.
export type IssueListResult = {
  items: IssueInfo[]
  error?: ClassifiedError
}

/**
 * Get a single issue by number.
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 *
 * Why this path doesn't take a preference: linked-issue lookups persist a
 * number to a worktree at creation time. Routing detail lookups through the
 * live per-repo preference would silently flip an existing link to a
 * different repo after the user toggled the selector — the opposite of what
 * #1186 / the parent design doc guard against. List and create paths honor
 * preference; number-resolution stays on the heuristic.
 */
export async function getIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null
): Promise<IssueInfo | null> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const ownerRepo = await getIssueOwnerRepo(repoPath, connectionId)
  await acquire()
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '300s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`
        ],
        ghOptions
      )
      const data = JSON.parse(stdout)
      return mapIssueInfo(data)
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels'],
      ghOptions
    )
    const data = JSON.parse(stdout)
    return mapIssueInfo(data)
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * List issues for a repo.
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 *
 * Why: returns a structured result so a 403 (e.g. fork contributor without
 * read access to a private upstream) surfaces as an error the UI can render
 * instead of collapsing to "No issues". The empty-list-on-error behavior this
 * replaces was explicitly flagged as a merge-blocker in the parent design doc
 * (§3) — silently hiding failures re-creates the same silent-source-switch
 * class of wrongness #1186 warned against, one level deeper.
 */
export async function listIssues(
  repoPath: string,
  limit = 20,
  preference?: IssueSourcePreference,
  connectionId?: string | null
): Promise<IssueListResult> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const { source: ownerRepo } = await resolveIssueSource(repoPath, preference, connectionId)
  await acquire()
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '120s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
        ],
        ghOptions
      )
      const data = JSON.parse(stdout) as Record<string, unknown>[]
      // Why: the GitHub REST `/repos/{owner}/{repo}/issues` endpoint returns
      // pull requests alongside issues (PRs carry a `pull_request` key).
      // Strip them here so `listIssues` only returns true issues, matching the
      // filter applied in `listRecentWorkItems` (src/main/github/client.ts).
      return {
        items: data
          .filter((d) => !('pull_request' in d))
          .map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
      }
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await ghExecFileAsync(
      ['issue', 'list', '--json', 'number,title,state,url,labels', '--limit', String(limit)],
      ghOptions
    )
    const data = JSON.parse(stdout) as unknown[]
    return {
      items: data.map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return {
      items: [],
      error: classifyListIssuesError(stderr)
    }
  } finally {
    release()
  }
}

/**
 * Create a new GitHub issue. Uses `gh api` with explicit owner/repo so the
 * call does not depend on the current working directory having a remote that
 * matches the repo the user picked in the tasks page.
 */
export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const { source: ownerRepo } = await resolveIssueSource(repoPath, preference, connectionId)
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
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues`,
        '--raw-field',
        `title=${trimmedTitle}`,
        '--raw-field',
        `body=${body}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as { number?: number; html_url?: string; url?: string }
    if (typeof data.number !== 'number') {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    return {
      ok: true,
      number: data.number,
      url: String(data.html_url ?? data.url ?? '')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

/**
 * Update an existing GitHub issue. Fans out to separate gh commands for
 * state changes vs field edits since `gh issue edit` does not support state.
 *
 * Why this path doesn't take a preference (mirrors `getIssue`): mutations
 * target an issue number already bound to a worktree / linked elsewhere in
 * the UI. Routing an update through the live per-repo preference would let
 * a user open upstream#N, toggle the selector to origin, save, and silently
 * write to origin#N — a different issue (or 404). That is the exact
 * silent-source-switch class of wrongness #1186 / the parent design doc
 * guard against. List and create paths honor preference; mutations stay on
 * the heuristic `getIssueOwnerRepo`.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitHubIssueUpdate,
  connectionId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const ownerRepo = await getIssueOwnerRepo(repoPath, connectionId)
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  const repo = `${ownerRepo.owner}/${ownerRepo.repo}`
  const errors: string[] = []

  // State change requires a separate command
  if (updates.state) {
    await acquire()
    try {
      const cmd = updates.state === 'closed' ? 'close' : 'reopen'
      await ghExecFileAsync(['issue', cmd, String(issueNumber), '--repo', repo], {
        ...ghOptions
      })
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      // Treat "already closed/open" as a no-op
      if (!stderr.toLowerCase().includes('already')) {
        errors.push(classifyGhError(stderr).message)
      }
    } finally {
      release()
    }
  }

  // Field edits (labels, assignees, title) via gh issue edit
  const editArgs: string[] = ['issue', 'edit', String(issueNumber), '--repo', repo]
  let hasEditArgs = false

  if (updates.title) {
    editArgs.push('--title', updates.title)
    hasEditArgs = true
  }
  for (const label of updates.addLabels ?? []) {
    editArgs.push('--add-label', label)
    hasEditArgs = true
  }
  for (const label of updates.removeLabels ?? []) {
    editArgs.push('--remove-label', label)
    hasEditArgs = true
  }
  for (const assignee of updates.addAssignees ?? []) {
    editArgs.push('--add-assignee', assignee)
    hasEditArgs = true
  }
  for (const assignee of updates.removeAssignees ?? []) {
    editArgs.push('--remove-assignee', assignee)
    hasEditArgs = true
  }

  if (hasEditArgs) {
    await acquire()
    try {
      await ghExecFileAsync(editArgs, ghOptions)
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err)
      errors.push(classifyGhError(stderr).message)
    } finally {
      release()
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}

/**
 * Add a comment to an existing GitHub issue.
 *
 * Why this path doesn't take a preference (mirrors `getIssue` / `updateIssue`):
 * a comment is posted against an issue number already bound to a worktree or
 * surfaced from a prior read. Routing through the live per-repo preference
 * would let a user read upstream#N, toggle the selector to origin, and have
 * their reply silently post on origin#N — a different issue entirely. That
 * is the same silent-source-switch class of wrongness #1186 / the parent
 * design doc guard against. List and create paths honor preference;
 * mutations stay on the heuristic `getIssueOwnerRepo`.
 */
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null
): Promise<GitHubCommentResult> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const ownerRepo = await getIssueOwnerRepo(repoPath, connectionId)
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
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments`,
        '--raw-field',
        `body=${body}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      id?: number
      user: { login: string; avatar_url: string; type?: string } | null
      body?: string
      created_at?: string
      html_url?: string
    }
    const comment: PRComment = {
      id: data.id ?? Date.now(),
      author: data.user?.login ?? 'You',
      authorAvatarUrl: data.user?.avatar_url ?? '',
      body: data.body ?? body,
      createdAt: data.created_at ?? new Date().toISOString(),
      url: data.html_url ?? '',
      isBot: data.user?.type === 'Bot'
    }
    return { ok: true, comment }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

export async function listLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null
): Promise<string[]> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const { source: ownerRepo } = await resolveIssueSource(repoPath, preference, connectionId)
  if (!ownerRepo) {
    return []
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/labels`,
        '--jq',
        '.[].name'
      ],
      ghOptions
    )
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
  } catch {
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null
): Promise<GitHubAssignableUser[]> {
  const context = githubRepoContext(repoPath, connectionId)
  const ghOptions = ghRepoExecOptions(context)
  const { source: ownerRepo } = await resolveIssueSource(repoPath, preference, connectionId)
  if (!ownerRepo) {
    return []
  }
  await acquire()
  try {
    // Why: paginate through all assignable users — GraphQL's assignableUsers
    // maxes out at 100 per page and large orgs/repos silently lose assignees
    // beyond the first page. REST /assignees with --paginate walks every page;
    // --jq collapses per-page arrays into NDJSON so we don't have to stitch
    // JSON arrays that gh concatenates back-to-back.
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/assignees?per_page=100`,
        '--jq',
        '.[] | {login, avatar_url}'
      ],
      ghOptions
    )
    type RESTAssignee = { login?: string; avatar_url?: string | null }
    const users: GitHubAssignableUser[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const user = JSON.parse(trimmed) as RESTAssignee
        if (user.login) {
          users.push({
            login: user.login,
            name: null,
            avatarUrl: user.avatar_url ?? ''
          })
        }
      } catch {
        // Skip malformed NDJSON lines defensively.
      }
    }
    return users
  } catch {
    return []
  } finally {
    release()
  }
}
