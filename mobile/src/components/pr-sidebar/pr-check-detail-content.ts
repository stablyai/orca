import type {
  PRCheckAnnotation,
  PRCheckJob,
  PRCheckRunDetails,
  PRCheckStep
} from '../../../../src/shared/github/check-types'

// Map check payload to desktop-equivalent summary/annotations/failed jobs without React/RN imports for Node tests.

// Desktop caps the inline lists so a noisy check can't break the layout; match it.
const MAX_ANNOTATIONS = 20
const MAX_JOBS = 100

function isFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

export type CheckDetailAnnotation = {
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
  failedSteps: CheckDetailStep[]
  logTail: string | null
}

export type CheckDetailContent = {
  summaryLines: string[]
  annotations: CheckDetailAnnotation[]
  annotationsTruncated: boolean
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

  // Prefer actionable failed jobs; show all only when none fail, matching desktop.
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
