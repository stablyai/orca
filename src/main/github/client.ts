import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PRInfo, IssueInfo, CheckStatus } from '../../shared/types'

const execFileAsync = promisify(execFile)

// Concurrency limiter - max 4 parallel gh processes
const MAX_CONCURRENT = 4
let running = 0
const queue: (() => void)[] = []

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++
      resolve()
    })
  )
}

function release(): void {
  running--
  const next = queue.shift()
  if (next) {
    next()
  }
}

/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 */
export async function getPRForBranch(repoPath: string, branch: string): Promise<PRInfo | null> {
  await acquire()
  try {
    // Strip refs/heads/ prefix if present
    const branchName = branch.replace(/^refs\/heads\//, '')
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branchName, '--json', 'number,title,state,url,statusCheckRollup,updatedAt'],
      {
        cwd: repoPath,
        encoding: 'utf-8'
      }
    )
    const data = JSON.parse(stdout)
    return {
      number: data.number,
      title: data.title,
      state: mapPRState(data.state),
      url: data.url,
      checksStatus: deriveCheckStatus(data.statusCheckRollup),
      updatedAt: data.updatedAt
    }
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Get a single issue by number.
 */
export async function getIssue(repoPath: string, issueNumber: number): Promise<IssueInfo | null> {
  await acquire()
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels'],
      {
        cwd: repoPath,
        encoding: 'utf-8'
      }
    )
    const data = JSON.parse(stdout)
    return {
      number: data.number,
      title: data.title,
      state: data.state?.toLowerCase() === 'open' ? 'open' : 'closed',
      url: data.url,
      labels: (data.labels || []).map((l: { name: string }) => l.name)
    }
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * List issues for a repo.
 */
export async function listIssues(repoPath: string, limit = 20): Promise<IssueInfo[]> {
  await acquire()
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'list', '--json', 'number,title,state,url,labels', '--limit', String(limit)],
      {
        cwd: repoPath,
        encoding: 'utf-8'
      }
    )
    const data = JSON.parse(stdout) as {
      number: number
      title: string
      state: string
      url: string
      labels: { name: string }[]
    }[]
    return data.map((d) => ({
      number: d.number,
      title: d.title,
      state: d.state?.toLowerCase() === 'open' ? ('open' as const) : ('closed' as const),
      url: d.url,
      labels: (d.labels || []).map((l) => l.name)
    }))
  } catch {
    return []
  } finally {
    release()
  }
}

export function mapPRState(state: string): PRInfo['state'] {
  const s = state?.toUpperCase()
  if (s === 'MERGED') {
    return 'merged'
  }
  if (s === 'CLOSED') {
    return 'closed'
  }
  // gh CLI returns isDraft separately, but state field is OPEN for drafts too
  return 'open'
}

export function deriveCheckStatus(rollup: unknown[] | null | undefined): CheckStatus {
  if (!rollup || !Array.isArray(rollup) || rollup.length === 0) {
    return 'neutral'
  }

  let hasFailure = false
  let hasPending = false

  for (const check of rollup as { status?: string; conclusion?: string; state?: string }[]) {
    const conclusion = check.conclusion?.toUpperCase()
    const status = check.status?.toUpperCase()
    const state = check.state?.toUpperCase()

    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'CANCELLED' ||
      state === 'FAILURE' ||
      state === 'ERROR'
    ) {
      hasFailure = true
    } else if (
      status === 'IN_PROGRESS' ||
      status === 'QUEUED' ||
      status === 'PENDING' ||
      state === 'PENDING'
    ) {
      hasPending = true
    }
  }

  if (hasFailure) {
    return 'failure'
  }
  if (hasPending) {
    return 'pending'
  }
  return 'success'
}
