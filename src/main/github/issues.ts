import type { ClassifiedError } from '../../shared/classified-error'
import type { IssueInfo } from '../../shared/github/pull-request-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapIssueInfo } from './mappers'
import type { LocalGitExecOptions } from './gh-utils'
import {
  getIssueGitHubApiRepository,
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
// prettier-ignore
import { ghExecFileAsync, acquire, release, classifyListIssuesError } from './gh-utils'

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
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<IssueInfo | null> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    () => getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions),
    connectionId,
    localGitOptions
  )
  // Why: a connection-backed request has no local cwd, so the non-GitHub
  // fallback below would let gh target its default repository. Refuse instead.
  if (connectionId && !ownerRepo) {
    return null
  }
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
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels,body'],
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
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<IssueListResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    async () =>
      (
        await resolveIssueGitHubApiRepositorySource(
          repoPath,
          preference,
          connectionId,
          localGitOptions
        )
      ).source,
    connectionId,
    localGitOptions
  )
  // Why: a connection-backed request has no local cwd, so the non-GitHub
  // fallback below would let gh list its default repository. Refuse instead.
  if (connectionId && !ownerRepo) {
    return {
      items: [],
      error: {
        type: 'not_found',
        message: 'Could not resolve GitHub owner/repo for this repository'
      }
    }
  }
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
