import type {
  ExternalAutomationJob,
  ExternalAutomationProvider,
  ExternalAutomationRun,
  ExternalAutomationRunStatus
} from '../../shared/automations-types'

type ExternalJobRecord = Record<string, unknown>

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatDurationMs(value: unknown): string {
  const ms = asNumber(value)
  if (!ms) {
    return '?'
  }
  if (ms % 86_400_000 === 0) {
    return `${ms / 86_400_000}d`
  }
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`
  }
  return `${ms}ms`
}

function isoFromMs(value: unknown): string | null {
  const ms = asNumber(value)
  if (!ms) {
    return null
  }
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function asExternalRunStatus(value: unknown): ExternalAutomationRunStatus {
  return value === 'completed' || value === 'failed' || value === 'unknown' ? value : 'unknown'
}

function mapExternalRuns({
  managerId,
  provider,
  jobId,
  rawRuns
}: {
  managerId: string
  provider: ExternalAutomationProvider
  jobId: string
  rawRuns: unknown
}): ExternalAutomationRun[] {
  if (!Array.isArray(rawRuns)) {
    return []
  }
  return rawRuns
    .filter(isRecord)
    .map((run, index) => {
      const runAt = asString(run.run_at) ?? asString(run.runAt)
      const id = asString(run.id) ?? `${jobId}:${runAt ?? index}`
      return {
        id,
        managerId,
        provider,
        jobId: asString(run.job_id) ?? asString(run.jobId) ?? jobId,
        runAt,
        status: asExternalRunStatus(run.status),
        outputPreview: asString(run.output_preview) ?? asString(run.outputPreview),
        outputContent: asString(run.output_content) ?? asString(run.outputContent),
        error: asString(run.error),
        outputPath: asString(run.output_path) ?? asString(run.outputPath)
      }
    })
    .sort((a, b) => {
      const aTime = a.runAt ? Date.parse(a.runAt) : Number.NaN
      const bTime = b.runAt ? Date.parse(b.runAt) : Number.NaN
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
        return bTime - aTime
      }
      return b.id.localeCompare(a.id)
    })
}

function hermesScheduleDisplay(job: ExternalJobRecord): string {
  const direct = asString(job.schedule_display)
  if (direct) {
    return direct
  }
  const schedule = job.schedule
  if (isRecord(schedule)) {
    return (
      asString(schedule.display) ??
      asString(schedule.value) ??
      asString(schedule.expr) ??
      asString(schedule.run_at) ??
      '?'
    )
  }
  return asString(schedule) ?? '?'
}

function hermesRawSchedule(job: ExternalJobRecord): string | null {
  const schedule = job.schedule
  if (isRecord(schedule)) {
    return (
      asString(schedule.expr) ??
      asString(schedule.value) ??
      asString(schedule.display) ??
      asString(schedule.run_at)
    )
  }
  return asString(schedule) ?? asString(job.schedule_display)
}

function hermesPromptPreview(job: ExternalJobRecord): string {
  const prompt = asString(job.prompt) ?? ''
  if (prompt) {
    return prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt
  }
  const script = asString(job.script)
  if (script) {
    return job.no_agent ? `Script: ${script}` : `Prompt uses script context: ${script}`
  }
  const skills = Array.isArray(job.skills) ? job.skills.map((skill) => String(skill)) : []
  return skills.length > 0 ? `Skills: ${skills.join(', ')}` : ''
}

function openClawScheduleDisplay(job: ExternalJobRecord): string {
  const schedule = job.schedule
  if (!isRecord(schedule)) {
    return asString(schedule) ?? '?'
  }
  const kind = asString(schedule.kind)
  if (kind === 'at') {
    return `at ${asString(schedule.at) ?? '?'}`
  }
  if (kind === 'every') {
    return `every ${formatDurationMs(schedule.everyMs)}`
  }
  if (kind === 'cron') {
    const expr = asString(schedule.expr) ?? asString(schedule.cron) ?? '?'
    const tz = asString(schedule.tz)
    return tz ? `cron ${expr} @ ${tz}` : `cron ${expr}`
  }
  return kind ?? '?'
}

function openClawRawSchedule(job: ExternalJobRecord): string | null {
  const schedule = job.schedule
  if (!isRecord(schedule)) {
    return asString(schedule)
  }
  return asString(schedule.expr) ?? asString(schedule.cron) ?? null
}

function openClawPromptPreview(job: ExternalJobRecord): string {
  const payload = job.payload
  if (!isRecord(payload)) {
    return ''
  }
  const text = asString(payload.message) ?? asString(payload.text) ?? ''
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

export function mapHermesJobs(managerId: string, rawJobs: unknown): ExternalAutomationJob[] {
  if (!Array.isArray(rawJobs)) {
    return []
  }
  return rawJobs.filter(isRecord).map((job) => {
    const id = asString(job.id) ?? 'unknown'
    const enabled = job.enabled !== false && job.state !== 'paused'
    const preview = hermesPromptPreview(job)
    return {
      id,
      managerId,
      provider: 'hermes',
      name: (asString(job.name) ?? preview) || id,
      schedule: hermesScheduleDisplay(job),
      rawSchedule: hermesRawSchedule(job),
      enabled,
      state: asString(job.state) ?? (enabled ? 'scheduled' : 'paused'),
      prompt: asString(job.prompt),
      promptPreview: preview,
      nextRunAt: asString(job.next_run_at),
      lastRunAt: asString(job.last_run_at),
      lastStatus: asString(job.last_status),
      lastError: asString(job.last_error) ?? asString(job.last_delivery_error),
      workdir: asString(job.workdir),
      runCount: asNumber(job.run_count) ?? (Array.isArray(job.runs) ? job.runs.length : 0),
      runs: mapExternalRuns({
        managerId,
        provider: 'hermes',
        jobId: id,
        rawRuns: job.runs
      })
    }
  })
}

export function mapOpenClawJobs(managerId: string, rawJobs: unknown): ExternalAutomationJob[] {
  const jobs = Array.isArray(rawJobs)
    ? rawJobs
    : isRecord(rawJobs) && Array.isArray(rawJobs.jobs)
      ? rawJobs.jobs
      : []
  return jobs.filter(isRecord).map((job) => {
    const id = asString(job.id) ?? 'unknown'
    const enabled = job.enabled !== false
    const state = isRecord(job.state) ? job.state : {}
    const preview = openClawPromptPreview(job)
    const lastStatus = asString(state.lastRunStatus) ?? asString(state.lastStatus)
    return {
      id,
      managerId,
      provider: 'openclaw',
      name: (asString(job.name) ?? preview) || id,
      schedule: openClawScheduleDisplay(job),
      rawSchedule: openClawRawSchedule(job),
      enabled,
      state: !enabled
        ? 'disabled'
        : asNumber(state.runningAtMs)
          ? 'running'
          : (lastStatus ?? 'idle'),
      prompt: openClawPromptPreview(job) || null,
      promptPreview: preview,
      nextRunAt: isoFromMs(state.nextRunAtMs),
      lastRunAt: isoFromMs(state.lastRunAtMs),
      lastStatus,
      lastError: asString(state.lastError) ?? asString(state.lastDeliveryError),
      workdir: null,
      runCount: asNumber(job.run_count) ?? (Array.isArray(job.runs) ? job.runs.length : 0),
      runs: mapExternalRuns({
        managerId,
        provider: 'openclaw',
        jobId: id,
        rawRuns: job.runs
      })
    }
  })
}
