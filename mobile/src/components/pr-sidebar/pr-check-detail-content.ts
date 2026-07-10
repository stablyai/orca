import type {
  PRCheckAnnotation,
  PRCheckJob,
  PRCheckRunDetails,
  PRCheckStep
} from '../../../../src/shared/types'

// Pure mapping from the github.prCheckDetails payload to the rows the mobile
// expanded check detail renders. No React/native imports so it stays unit-testable
// under the node Vitest config (KTD5). Ports the desktop CheckDetailExpanded logic
// (conclusion/title/summary + annotations + failed-job/step summary), not its JSX.

// Desktop caps the inline lists so a noisy check can't break the layout; match it.
const MAX_ANNOTATIONS = 20
const MAX_JOBS = 100

function isFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

export type CheckDetailAnnotation = {
  // Path:line locator (or "Annotation" when the host omits a path).
  locator: string
  level: string | null
  title: string | null
  message: string
}

export type CheckDetailStep = {
  name: string
  state: string
}

export type CheckDetailJob = {
  name: string
  state: string
  // Failed steps within the job; empty when none reported as failing.
  failedSteps: CheckDetailStep[]
  logTail: string | null
}

export type CheckDetailContent = {
  // Conclusion/title/summary lines, in render order (matches the prior mobile detail).
  summaryLines: string[]
  annotations: CheckDetailAnnotation[]
  // True when the host returned more annotations than we render.
  annotationsTruncated: boolean
  // "Failed jobs" when only failing jobs are shown, else "Jobs" (matches desktop label).
  jobsLabel: 'Failed jobs' | 'Jobs'
  jobs: CheckDetailJob[]
  jobsTruncated: boolean
}

function mapAnnotation(annotation: PRCheckAnnotation): CheckDetailAnnotation {
  const path = annotation.path ?? 'Annotation'
  const locator = annotation.startLine ? `${path}:${annotation.startLine}` : path
  return {
    locator,
    level: annotation.annotationLevel,
    title: annotation.title,
    message: annotation.message
  }
}

function mapJob(job: PRCheckJob): CheckDetailJob {
  const failedSteps = job.steps
    .filter((step: PRCheckStep) => isFailureState(step.conclusion ?? step.status))
    .map((step) => ({ name: step.name, state: step.conclusion ?? step.status ?? 'unknown' }))
  return {
    name: job.name,
    state: job.conclusion ?? job.status ?? 'unknown',
    failedSteps,
    logTail: job.logTail
  }
}

export function presentCheckDetail(details: PRCheckRunDetails): CheckDetailContent {
  const summaryLines = [
    details.conclusion ?? details.status,
    details.title,
    details.summary
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0)

  // Why: prefer failing jobs (the actionable ones); fall back to all jobs only
  // when nothing is failing, matching the desktop panel.
  const failedJobs = details.jobs.filter((job) => isFailureState(job.conclusion ?? job.status))
  const visibleJobs = failedJobs.length > 0 ? failedJobs : details.jobs

  return {
    summaryLines,
    annotations: details.annotations.slice(0, MAX_ANNOTATIONS).map(mapAnnotation),
    annotationsTruncated: details.annotations.length > MAX_ANNOTATIONS,
    jobsLabel: failedJobs.length > 0 ? 'Failed jobs' : 'Jobs',
    jobs: visibleJobs.slice(0, MAX_JOBS).map(mapJob),
    jobsTruncated: details.jobs.length > MAX_JOBS
  }
}
