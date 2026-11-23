import type {
  AzureDevOpsBuildLog,
  AzureDevOpsBuildStep,
  AzureDevOpsPrBuild
} from '../../../shared/azure-devops/azure-devops-pr-review-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import type { PullRequestLocation } from './pr-review-read-client'

const BUILD_TIMEOUT_MS = 20_000
export const BUILD_LOG_DEFAULT_TAIL = 150
export const BUILD_LOG_MAX_TAIL = 1000
// A failing build can have many failed tasks; the first few carry the cause.
const MAX_FAILED_LOGS = 3

type RawTimelineRecord = {
  name?: string | null
  type?: string | null
  state?: string | null
  result?: string | null
  errorCount?: number | null
  order?: number | null
  log?: { id?: number | null } | null
  issues?: { type?: string | null; message?: string | null }[] | null
}

/** Steps in run order; a step's issues keep only their messages. */
export function mapBuildTimeline(
  records: RawTimelineRecord[] | null | undefined
): AzureDevOpsBuildStep[] {
  return (records ?? [])
    .filter((record) => record.type !== 'Checkpoint' && typeof record.name === 'string')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((record) => ({
      name: record.name ?? '',
      type: record.type ?? 'Task',
      state: record.state ?? null,
      result: record.result ?? null,
      errorCount: Math.max(0, record.errorCount ?? 0),
      logId: typeof record.log?.id === 'number' ? record.log.id : null,
      issues: (record.issues ?? []).flatMap((issue) =>
        issue.message ? [`${issue.type ?? 'issue'}: ${issue.message}`] : []
      )
    }))
}

export function tailLogLines(lines: readonly string[], tail: number): AzureDevOpsBuildLog['lines'] {
  return lines.slice(Math.max(0, lines.length - tail))
}

type RawBuild = {
  id?: number
  buildNumber?: string | null
  status?: string | null
  result?: string | null
  sourceBranch?: string | null
  sourceVersion?: string | null
  startTime?: string | null
  finishTime?: string | null
  definition?: { name?: string | null } | null
  _links?: { web?: { href?: string | null } | null } | null
}

/** A build from a PR's policy checks, its steps, and optionally the tails of its failed task logs. */
export async function getAzureDevOpsPullRequestBuild(
  location: PullRequestLocation,
  buildId: number,
  options: { logs?: boolean; tail?: number } = {}
): Promise<AzureDevOpsPrBuild> {
  const base = `/${encodeURIComponent(location.projectId)}/_apis/build/builds/${encodeURIComponent(String(buildId))}`
  const [build, timeline] = await Promise.all([
    requestAzureDevOpsJsonAtBase<RawBuild>(
      location.collection,
      base,
      { timeoutMs: BUILD_TIMEOUT_MS },
      true
    ),
    requestAzureDevOpsJsonAtBase<{ records?: RawTimelineRecord[] }>(
      location.collection,
      `${base}/timeline`,
      { timeoutMs: BUILD_TIMEOUT_MS },
      true
    )
  ])
  if (!build || typeof build.id !== 'number') {
    throw new Error(`Build ${buildId} was not found in this pull request's project.`)
  }
  const steps = mapBuildTimeline(timeline?.records)
  const tail = Math.min(
    Math.max(1, Math.floor(options.tail ?? BUILD_LOG_DEFAULT_TAIL)),
    BUILD_LOG_MAX_TAIL
  )
  const failed = options.logs
    ? steps
        .filter((step) => step.type === 'Task' && step.result === 'failed' && step.logId !== null)
        .slice(0, MAX_FAILED_LOGS)
    : []
  const logs = await Promise.all(
    failed.map(async (step): Promise<AzureDevOpsBuildLog> => {
      const raw = await requestAzureDevOpsJsonAtBase<{ value?: unknown[] }>(
        location.collection,
        `${base}/logs/${encodeURIComponent(String(step.logId))}`,
        { timeoutMs: BUILD_TIMEOUT_MS },
        true
      )
      const lines = (raw?.value ?? []).filter((line): line is string => typeof line === 'string')
      return { step: step.name, lines: tailLogLines(lines, tail), truncated: lines.length > tail }
    })
  )
  return {
    id: build.id,
    number: build.buildNumber ?? null,
    definition: build.definition?.name ?? null,
    status: build.status ?? null,
    result: build.result ?? null,
    sourceBranch: build.sourceBranch ?? null,
    sourceVersion: build.sourceVersion ?? null,
    startTime: build.startTime ?? null,
    finishTime: build.finishTime ?? null,
    url: build._links?.web?.href ?? null,
    steps,
    logs
  }
}
