import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PRInfo, IssueInfo, PRCheckDetail } from '../../shared/types'
import {
  mapCheckRunRESTStatus,
  mapCheckRunRESTConclusion,
  mapCheckStatus,
  mapCheckConclusion,
  mapPRState,
  deriveCheckStatus,
  mapIssueInfo
} from './mappers'

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

// ── Owner/repo resolution for gh api --cache ──────────────────────────
const ownerRepoCache = new Map<string, { owner: string; repo: string } | null>()

async function getOwnerRepo(repoPath: string): Promise<{ owner: string; repo: string } | null> {
  if (ownerRepoCache.has(repoPath)) {
    return ownerRepoCache.get(repoPath)!
  }
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      encoding: 'utf-8'
    })
    const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
    if (match) {
      const result = { owner: match[1], repo: match[2] }
      ownerRepoCache.set(repoPath, result)
      return result
    }
  } catch {
    // ignore — non-GitHub remote or no remote
  }
  ownerRepoCache.set(repoPath, null)
  return null
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
      [
        'pr',
        'view',
        branchName,
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft'
      ],
      {
        cwd: repoPath,
        encoding: 'utf-8'
      }
    )
    const data = JSON.parse(stdout)
    return {
      number: data.number,
      title: data.title,
      state: mapPRState(data.state, data.isDraft),
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
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 */
export async function getIssue(repoPath: string, issueNumber: number): Promise<IssueInfo | null> {
  const ownerRepo = await getOwnerRepo(repoPath)
  await acquire()
  try {
    if (ownerRepo) {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--cache',
          '300s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`
        ],
        { cwd: repoPath, encoding: 'utf-8' }
      )
      const data = JSON.parse(stdout)
      return mapIssueInfo(data)
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels'],
      { cwd: repoPath, encoding: 'utf-8' }
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
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--cache',
          '120s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
        ],
        { cwd: repoPath, encoding: 'utf-8' }
      )
      const data = JSON.parse(stdout) as unknown[]
      return data.map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
    }
    // Fallback for non-GitHub remotes
    const { stdout } = await execFileAsync(
      'gh',
      ['issue', 'list', '--json', 'number,title,state,url,labels', '--limit', String(limit)],
      { cwd: repoPath, encoding: 'utf-8' }
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
 * Get detailed check statuses for a PR.
 * When branch is provided, uses gh api --cache with the check-runs REST endpoint
 * so 304 Not Modified responses don't count against the rate limit.
 */
export async function getPRChecks(
  repoPath: string,
  prNumber: number,
  branch?: string
): Promise<PRCheckDetail[]> {
  const ownerRepo = branch ? await getOwnerRepo(repoPath) : null
  await acquire()
  try {
    if (ownerRepo && branch) {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--cache',
          '60s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`
        ],
        { cwd: repoPath, encoding: 'utf-8' }
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
    }
    // Fallback: no branch provided or non-GitHub remote
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'checks', String(prNumber), '--json', 'name,state,link'],
      { cwd: repoPath, encoding: 'utf-8' }
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
    await execFileAsync('gh', ['pr', 'merge', String(prNumber), `--${method}`], {
      cwd: repoPath,
      encoding: 'utf-8',
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
    await execFileAsync('gh', ['pr', 'edit', String(prNumber), '--title', title], {
      cwd: repoPath,
      encoding: 'utf-8'
    })
    return true
  } catch (err) {
    console.warn('updatePRTitle failed:', err)
    return false
  } finally {
    release()
  }
}
