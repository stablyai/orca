import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import { sliceCheckLogTail } from '../../../../shared/check-job-log-tail-slice'
import { ghExecFileAsync } from '../../gh-utils'
import type { GitHubApiRepository } from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import type { GhExecOptions } from './../github-exec-scope'
import { rethrowCheckDetailsAbort } from './check-details-abort'
export const PR_CHECK_LOG_TAIL_JOB_LIMIT = 5

// Why: only the tail is kept, but the whole log buffers first — the default 10MiB cap drops long CI logs.
// Still far below the V8 string ceiling that DEFAULT_GIT_MAX_BUFFER guards against.
export const PR_CHECK_LOG_MAX_BUFFER = 64 * 1024 * 1024

// Why: each entry holds up to 16KB of log text; bound the cache so a long session can't grow it unbounded.
export const PR_CHECK_LOG_TAIL_CACHE_MAX_ENTRIES = 128

export const prCheckLogTailCache = new Map<string, string | null>()

export function setPrCheckLogTailCache(cacheKey: string, logTail: string | null): void {
  prCheckLogTailCache.set(cacheKey, logTail)
  while (prCheckLogTailCache.size > PR_CHECK_LOG_TAIL_CACHE_MAX_ENTRIES) {
    const oldestKey = prCheckLogTailCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    prCheckLogTailCache.delete(oldestKey)
  }
}

export function isCheckJobFailureState(state: string | null | undefined): boolean {
  return (
    state === 'failure' ||
    state === 'failed' ||
    state === 'action_required' ||
    state === 'cancelled' ||
    state === 'stale' ||
    state === 'startup_failure' ||
    state === 'timed_out'
  )
}

export function getCheckJobLogTailCacheKey(job: PRCheckRunDetails['jobs'][number]): string | null {
  if (job.id === null) {
    return null
  }
  return `${job.id}:${job.completedAt ?? ''}`
}

export async function attachFailedJobLogTails(
  jobs: PRCheckRunDetails['jobs'],
  ownerRepo: GitHubApiRepository,
  ghOptions: GhExecOptions
): Promise<void> {
  const failedJobs = jobs
    .filter((job) => {
      const state = job.conclusion ?? job.status
      return job.id !== null && isCheckJobFailureState(state)
    })
    .slice(0, PR_CHECK_LOG_TAIL_JOB_LIMIT)

  // Why: cap log fetches so failed-job details stay a bounded follow-up, not a burst of hosted log downloads.
  for (const job of failedJobs) {
    const jobCacheKey = getCheckJobLogTailCacheKey(job)
    const cacheKey = jobCacheKey ? `${githubRepoIdentityKey(ownerRepo)}:${jobCacheKey}` : null
    if (!cacheKey) {
      continue
    }
    if (prCheckLogTailCache.has(cacheKey)) {
      job.logTail = prCheckLogTailCache.get(cacheKey) ?? null
      continue
    }
    try {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/jobs/${job.id}/logs`],
        { ...ghOptions, maxBuffer: PR_CHECK_LOG_MAX_BUFFER }
      )
      job.logTail = sliceCheckLogTail(stdout)
    } catch (err) {
      rethrowCheckDetailsAbort(ghOptions.signal, err)
      console.warn('getPRCheckDetails workflow job log fetch failed:', err)
      job.logTail = null
    }
    setPrCheckLogTailCache(cacheKey, job.logTail)
  }
}
