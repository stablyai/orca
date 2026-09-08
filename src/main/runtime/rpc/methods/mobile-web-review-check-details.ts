import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import type { MobileWebProviderReviewQueryResult } from '../../../../shared/mobile-web/provider-review-query-contract'

type CheckDetails = Extract<
  MobileWebProviderReviewQueryResult,
  { query: 'checkDetails' }
>['details']

/** A workflow run can carry a hundred jobs of log tail, which no per-field cap bounds in total, so
 *  the oldest jobs drop until the page's answer fits one transport payload. */
const MAX_CHECK_DETAILS_BYTES = 256 * 1024

export function clipMobileWebReviewCheckDetails(run: PRCheckRunDetails | null): CheckDetails {
  if (!run) {
    return null
  }
  const withoutJobs = {
    name: run.name.slice(0, 256),
    status: run.status?.slice(0, 80) ?? null,
    conclusion: run.conclusion?.slice(0, 80) ?? null,
    startedAt: run.startedAt?.slice(0, 64) ?? null,
    completedAt: run.completedAt?.slice(0, 64) ?? null,
    title: run.title?.slice(0, 512) ?? null,
    summary: run.summary?.slice(0, 16 * 1024) ?? null,
    annotations: run.annotations.slice(0, 20).map((annotation) => ({
      path: annotation.path?.slice(0, 1024) ?? null,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      annotationLevel: annotation.annotationLevel?.slice(0, 80) ?? null,
      title: annotation.title?.slice(0, 512) ?? null,
      message: annotation.message.slice(0, 8 * 1024)
    }))
  }
  const jobs = run.jobs.slice(0, 100).map((job) => ({
    name: job.name.slice(0, 256),
    status: job.status?.slice(0, 80) ?? null,
    conclusion: job.conclusion?.slice(0, 80) ?? null,
    logTail: job.logTail?.slice(0, 32 * 1024) ?? null,
    steps: job.steps.slice(0, 100).map((step) => ({
      name: step.name.slice(0, 256),
      status: step.status?.slice(0, 80) ?? null,
      conclusion: step.conclusion?.slice(0, 80) ?? null
    }))
  }))
  while (
    Buffer.byteLength(JSON.stringify({ ...withoutJobs, jobs: [] })) > MAX_CHECK_DETAILS_BYTES &&
    withoutJobs.annotations.length
  ) {
    withoutJobs.annotations.pop()
  }
  const budget =
    MAX_CHECK_DETAILS_BYTES - Buffer.byteLength(JSON.stringify({ ...withoutJobs, jobs: [] }))
  return { ...withoutJobs, jobs: retainedJobs(jobs, budget) }
}

/** Newest first: the job a reader opened check details for is the one that just failed. */
function retainedJobs<T>(jobs: T[], budget: number): T[] {
  const retained: T[] = []
  let remaining = budget
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(JSON.stringify(jobs[index])) + 1
    if (size > remaining) {
      break
    }
    remaining -= size
    retained.unshift(jobs[index]!)
  }
  return retained
}
