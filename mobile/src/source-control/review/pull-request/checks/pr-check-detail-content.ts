import type {
  PRCheckAnnotation,
  PRCheckJob,
  PRCheckRunDetails
} from '../../../../../../src/shared/github/checks/check-types'
import {
  resolveStepOutcome,
  summarizeJobSteps
} from '../../../../../../src/shared/source-control/checks/pr-check-step-status'
import type { Translate } from '../../../../i18n/mobile-i18n'

// Map check payload to desktop-equivalent summary/annotations/failed jobs without React/RN imports for Node tests.

// Desktop caps the inline lists so a noisy check can't break the layout; match it.
const MAX_ANNOTATIONS = 20
const MAX_JOBS = 100

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
  jobsLabel: string
  jobs: CheckDetailJob[]
  jobsTruncated: boolean
}

function mapAnnotation(annotation: PRCheckAnnotation, t: Translate): CheckDetailAnnotation {
  const path = annotation.path ?? t('pullRequest.prCheckDetailContent.annotation', 'Annotation')
  const locator = annotation.startLine ? `${path}:${annotation.startLine}` : path
  return {
    locator,
    level: annotation.annotationLevel,
    title: annotation.title,
    message: annotation.message
  }
}

function mapJob(job: PRCheckJob, t: Translate): CheckDetailJob {
  const failedSteps = summarizeJobSteps(job).failed.map((step) => ({
    name: step.name,
    state:
      step.conclusion ?? step.status ?? t('pullRequest.prCheckDetailContent.unknown', 'unknown')
  }))
  return {
    name: job.name,
    state: job.conclusion ?? job.status ?? t('pullRequest.prCheckDetailContent.unknown', 'unknown'),
    failedSteps,
    logTail: job.logTail
  }
}

export function presentCheckDetail(details: PRCheckRunDetails, t: Translate): CheckDetailContent {
  const summaryLines = [
    details.conclusion ?? details.status,
    details.title,
    details.summary
  ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0)

  // Prefer actionable failed jobs; show all only when none fail, matching desktop.
  const failedJobs = details.jobs.filter((job) => resolveStepOutcome(job) === 'failure')
  const visibleJobs = failedJobs.length > 0 ? failedJobs : details.jobs

  return {
    summaryLines,
    annotations: details.annotations
      .slice(0, MAX_ANNOTATIONS)
      .map((annotation) => mapAnnotation(annotation, t)),
    annotationsTruncated: details.annotations.length > MAX_ANNOTATIONS,
    jobsLabel:
      failedJobs.length > 0
        ? t('pullRequest.prCheckDetailContent.failedJobs', 'Failed jobs')
        : t('pullRequest.prCheckDetailContent.jobs', 'Jobs'),
    jobs: visibleJobs.slice(0, MAX_JOBS).map((job) => mapJob(job, t)),
    jobsTruncated: details.jobs.length > MAX_JOBS
  }
}
