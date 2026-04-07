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
