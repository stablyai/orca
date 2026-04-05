import type { PRInfo, PRMergeableState, PRCheckDetail } from '../../shared/types'
import { getPRConflictSummary } from './conflict-summary'
import { execFileAsync, acquire, release, getOwnerRepo } from './gh-utils'
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
      const { stdout } = await execFileAsync(
        'gh',
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
        {
          cwd: repoPath,
          encoding: 'utf-8'
        }
      )
      const list = JSON.parse(stdout) as NonNullable<typeof data>[]
      data = list[0] ?? null
    } else {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'view',
          branchName,
          '--json',
          'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
        ],
        {
          cwd: repoPath,
          encoding: 'utf-8'
        }
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
        const { stdout } = await execFileAsync(
          'gh',
          [
            'api',
            ...cacheArgs,
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`
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
      } catch (err) {
        // Why: a PR can outlive the cached head SHA after force-pushes or remote
        // rewrites. Falling back to `gh pr checks` keeps the panel populated
        // instead of rendering a false "no checks" state from a stale commit.
        console.warn('getPRChecks via head SHA failed, falling back to gh pr checks:', err)
      }
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
