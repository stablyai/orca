import type { IssueInfo, GitHubIssueUpdate } from '../../shared/types'
import { mapIssueInfo } from './mappers'
import { ghExecFileAsync, acquire, release, getOwnerRepo, classifyGhError } from './gh-utils'

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
        '--raw-field',
        `title=${trimmedTitle}`,
        '--raw-field',
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

/**
 * Update an existing GitHub issue. Fans out to separate gh commands for
 * state changes vs field edits since `gh issue edit` does not support state.
 */
export async function updateIssue(
  repoPath: string,
  issueNumber: number,
  updates: GitHubIssueUpdate
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
        cwd: repoPath
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
      await ghExecFileAsync(editArgs, { cwd: repoPath })
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

export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
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
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments`,
        '--raw-field',
        `body=${body}`
      ],
      { cwd: repoPath }
    )
    const data = JSON.parse(stdout) as { id?: number }
    return { ok: true, id: data.id ?? 0 }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

export async function listLabels(repoPath: string): Promise<string[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
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
      { cwd: repoPath }
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

export async function listAssignableUsers(repoPath: string): Promise<string[]> {
  const ownerRepo = await getOwnerRepo(repoPath)
  if (!ownerRepo) {
    return []
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/assignees`,
        '--jq',
        '.[].login'
      ],
      { cwd: repoPath }
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
