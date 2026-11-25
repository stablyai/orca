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
  id?: string | null
  parentId?: string | null
  name?: string | null
  type?: string | null
  state?: string | null
  result?: string | null
  errorCount?: number | null
  order?: number | null
  log?: { id?: number | null } | null
  issues?: { type?: string | null; message?: string | null }[] | null
}

/** Run order is per parent (stage, job, task), so siblings are sorted and the tree walked depth first. */
function inRunOrder(records: RawTimelineRecord[]): RawTimelineRecord[] {
  const ids = new Set(records.map((record) => record.id).filter((id): id is string => Boolean(id)))
  const children = new Map<string | null, RawTimelineRecord[]>()
  for (const record of records) {
    const parent = record.parentId && ids.has(record.parentId) ? record.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), record])
  }
  const ordered: RawTimelineRecord[] = []
  const visit = (parent: string | null): void => {
    const siblings = [...(children.get(parent) ?? [])].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0)
    )
    for (const record of siblings) {
      ordered.push(record)
      if (record.id) {
        visit(record.id)
      }
    }
  }
  visit(null)
  return ordered
}

/** Steps in run order; a step's issues keep only their messages. */
export function mapBuildTimeline(
  records: RawTimelineRecord[] | null | undefined
): AzureDevOpsBuildStep[] {
  return inRunOrder(records ?? [])
    .filter((record) => record.type !== 'Checkpoint' && typeof record.name === 'string')
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
  // Line counts let each failed log be read from its last `tail` lines instead of in full.
  const lineCounts = new Map<number, number>()
  if (failed.length > 0) {
    const meta = await requestAzureDevOpsJsonAtBase<{
      value?: { id?: number; lineCount?: number }[]
    }>(location.collection, `${base}/logs`, { timeoutMs: BUILD_TIMEOUT_MS }, true)
    for (const log of meta?.value ?? []) {
      if (typeof log.id === 'number' && typeof log.lineCount === 'number') {
        lineCounts.set(log.id, log.lineCount)
      }
    }
  }
  const logs = await Promise.all(
    failed.map(async (step): Promise<AzureDevOpsBuildLog> => {
      const lineCount = lineCounts.get(step.logId ?? -1)
      const range: Record<string, string> =
        lineCount === undefined
          ? {}
          : { startLine: String(Math.max(1, lineCount - tail + 1)), endLine: String(lineCount) }
      const raw = await requestAzureDevOpsJsonAtBase<{ value?: unknown[] }>(
        location.collection,
        `${base}/logs/${encodeURIComponent(String(step.logId))}`,
        { searchParams: range, timeoutMs: BUILD_TIMEOUT_MS },
        true
      )
      const lines = (raw?.value ?? []).filter((line): line is string => typeof line === 'string')
      return {
        step: step.name,
        lines: tailLogLines(lines, tail),
        truncated: (lineCount ?? lines.length) > tail
      }
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
