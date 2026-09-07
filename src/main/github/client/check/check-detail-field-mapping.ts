import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function mapCheckAnnotations(raw: unknown): PRCheckRunDetails['annotations'] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .filter((annotation): annotation is Record<string, unknown> => Boolean(annotation))
    .map((annotation) => ({
      path: nullableString(annotation.path),
      startLine: nullableNumber(annotation.start_line),
      endLine: nullableNumber(annotation.end_line),
      annotationLevel: nullableString(annotation.annotation_level),
      title: nullableString(annotation.title),
      message: nullableString(annotation.message) ?? '',
      rawDetails: nullableString(annotation.raw_details)
    }))
}

export function mapWorkflowJobs(raw: unknown, checkName?: string): PRCheckRunDetails['jobs'] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { jobs?: unknown }).jobs)) {
    return []
  }
  const jobs = (raw as { jobs: unknown[] }).jobs
    .filter((job): job is Record<string, unknown> => Boolean(job))
    .map((job) => ({
      id: nullableNumber(job.id),
      name: nullableString(job.name) ?? 'Unnamed job',
      status: nullableString(job.status),
      conclusion: nullableString(job.conclusion),
      startedAt: nullableString(job.started_at),
      completedAt: nullableString(job.completed_at),
      url: nullableString(job.html_url),
      logTail: null,
      steps: Array.isArray(job.steps)
        ? job.steps
            .filter((step): step is Record<string, unknown> => Boolean(step))
            .map((step) => ({
              name: nullableString(step.name) ?? 'Unnamed step',
              status: nullableString(step.status),
              conclusion: nullableString(step.conclusion),
              startedAt: nullableString(step.started_at),
              completedAt: nullableString(step.completed_at)
            }))
        : []
    }))
  const exactMatches = checkName ? jobs.filter((job) => job.name === checkName) : []
  return exactMatches.length > 0 ? exactMatches : jobs
}

export function getWorkflowRunIdFromCheckRun(
  checkRun: Record<string, unknown> | null
): number | undefined {
  const checkSuite = checkRun?.check_suite
  if (!checkSuite || typeof checkSuite !== 'object') {
    return undefined
  }
  const workflowRun = (checkSuite as { workflow_run?: unknown }).workflow_run
  if (!workflowRun || typeof workflowRun !== 'object') {
    return undefined
  }
  const id = (workflowRun as { id?: unknown }).id
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined
}

export function parseActionsRunId(url: string | null | undefined): number | undefined {
  if (!url) {
    return undefined
  }
  const match = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url)
  if (!match) {
    return undefined
  }
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : undefined
}
