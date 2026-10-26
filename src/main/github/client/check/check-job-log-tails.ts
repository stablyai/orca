import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import { sliceCheckLogTail } from '../../../../shared/check-job-log-tail-slice'
import type { GitHubApiRepository } from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import type { GhExecOptions } from './../github-exec-scope'
import { rethrowCheckDetailsAbort, waitForCheckDetailsResolution } from './check-details-abort'
import { assertCheckLogActive, startCheckJobLogDownload } from './check-job-log-download'
import { requestSharedCheckJobLog } from './check-job-log-inflight'
export { PR_CHECK_LOG_MAX_BUFFER } from './check-job-log-download'
export type CheckJobLogContext = {
  deadlineAt: number
  executionScope: string | null
  retainUntil: (terminated: Promise<void>) => void
}
export const PR_CHECK_LOG_TAIL_JOB_LIMIT = 5

export const PR_CHECK_LOG_TAIL_CACHE_MAX_ENTRIES = 128

type LogExcerpt = { readonly logTail: string | null; readonly logState: 'available' | 'empty' }
export const prCheckLogTailCache = new Map<string, LogExcerpt>()

function excerpt(value: string): LogExcerpt {
  return value.length === 0
    ? { logTail: null, logState: 'empty' }
    : { logTail: value, logState: 'available' }
}

function setPrCheckLogTailCache(cacheKey: string, value: string): void {
  prCheckLogTailCache.set(cacheKey, excerpt(value))
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

export function getCheckJobLogTailCacheKey(
  job: PRCheckRunDetails['jobs'][number],
  ownerRepo: GitHubApiRepository,
  executionScope: string | null
): string | null {
  if (
    !executionScope ||
    !Number.isSafeInteger(job.id) ||
    job.id === null ||
    job.id <= 0 ||
    job.status !== 'completed' ||
    !job.completedAt
  ) {
    return null
  }
  return JSON.stringify([githubRepoIdentityKey(ownerRepo), job.id, job.completedAt, executionScope])
}

export async function attachFailedJobLogTails(
  jobs: PRCheckRunDetails['jobs'],
  ownerRepo: GitHubApiRepository,
  ghOptions: GhExecOptions,
  context: CheckJobLogContext
): Promise<void> {
  const signal = ghOptions.signal
  if (!signal) {
    throw new Error('Check details request is unavailable.')
  }
  assertCheckLogActive(signal, context.deadlineAt)
  for (const job of jobs) {
    job.logTail = null
    job.logState = 'not_requested'
  }
  const failedJobs = jobs
    .filter((job) => {
      const state = job.conclusion ?? job.status
      return (
        job.id !== null &&
        Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        isCheckJobFailureState(state)
      )
    })
    .slice(0, PR_CHECK_LOG_TAIL_JOB_LIMIT)

  for (const job of failedJobs) {
    assertCheckLogActive(signal, context.deadlineAt)
    if (job.id === null) {
      continue
    }
    const jobId = job.id
    const cacheKey = getCheckJobLogTailCacheKey(job, ownerRepo, context.executionScope)
    let terminated = Promise.resolve()
    const start = (
      operationSignal: AbortSignal,
      deadlineAt: number
    ): { result: Promise<string>; terminated: Promise<void> } => {
      const call = startCheckJobLogDownload(
        ownerRepo,
        jobId,
        { ...ghOptions, signal: operationSignal },
        deadlineAt,
        context.retainUntil
      )
      terminated = call.terminated
      return {
        result: call.result.then((stdout) => {
          assertCheckLogActive(operationSignal, deadlineAt)
          return sliceCheckLogTail(stdout)
        }),
        terminated: call.terminated
      }
    }
    try {
      const value = cacheKey
        ? await requestSharedCheckJobLog({
            key: cacheKey,
            signal,
            deadlineAt: context.deadlineAt,
            cached: () => {
              const value = prCheckLogTailCache.get(cacheKey)
              return value ? (value.logTail ?? '') : undefined
            },
            publish: (value) => setPrCheckLogTailCache(cacheKey, value),
            start
          })
        : await start(signal, context.deadlineAt).result
      assertCheckLogActive(signal, context.deadlineAt)
      Object.assign(job, excerpt(value))
    } catch (err) {
      rethrowCheckDetailsAbort(ghOptions.signal, err)
      assertCheckLogActive(signal, context.deadlineAt)
      console.warn('getPRCheckDetails', 'job_log_failed')
      job.logTail = null
      job.logState = 'error'
    }
    await waitForCheckDetailsResolution(terminated, signal)
    assertCheckLogActive(signal, context.deadlineAt)
  }
}
