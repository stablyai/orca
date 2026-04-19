import type { IssueInfo } from '../../shared/types'
import { mapIssueInfo } from './mappers'
import { ghExecFileAsync, acquire, release, getOwnerRepo } from './gh-utils'

/**
 * Get a single issue by number.
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 */
export async function getIssue(repoPath: string, issueNumber: number): Promise<IssueInfo | null> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
        { cwd: repoPath }
      )
      const data = JSON.parse(stdout)
      return mapIssueInfo(data)
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels'],
      { cwd: repoPath }
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
 */
export async function listIssues(repoPath: string, limit = 20): Promise<IssueInfo[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
        { cwd: repoPath }
      )
      const data = JSON.parse(stdout) as unknown[]
      return data.map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await ghExecFileAsync(
      ['issue', 'list', '--json', 'number,title,state,url,labels', '--limit', String(limit)],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as unknown[]
    return data.map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
  } catch {
    return []
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
  body: string
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const ownerRepo = await getOwnerRepo(repoPath)
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
        '-f',
        `title=${trimmedTitle}`,
        '-f',
        `body=${body}`
      ],
      { cwd: repoPath }
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
