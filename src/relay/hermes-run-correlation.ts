import { HermesSessionRunIndex } from '../shared/hermes-session-run-index'
const HERMES_RUN_KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/
const MAX_SESSION_OUTPUT_GAP_MS = 24 * 60 * 60 * 1000
const FULL_SESSION_LOG_HEADING = '## Full session log'

export type HermesOutputRunRef = {
  kind: 'output'
  id: string
  job_id: string
  run_at: string | null
  run_key: string | null
  output_path: string
}

export type HermesSessionRunRef = {
  kind: 'session'
  id: string
  job_id: string
  run_at: string | null
  run_key: string | null
}

export type HermesMergedRunRef = {
  id: string
  job_id: string
  run_at: string | null
  run_key: string | null
  output: HermesOutputRunRef | null
  session: HermesSessionRunRef | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getRunKey(run: unknown): string | null {
  return isRecord(run) && typeof run.run_key === 'string' && run.run_key.trim() ? run.run_key : null
}

function getRunOutputContent(run: unknown): string | null {
  return isRecord(run) && typeof run.output_content === 'string' && run.output_content.trim()
    ? run.output_content
    : null
}

function getRunOutputPreview(run: unknown): string | null {
  return isRecord(run) && typeof run.output_preview === 'string' && run.output_preview.trim()
    ? run.output_preview
    : null
}

function sortableTimeFromRunKey(runKey: string | null): number {
  if (!runKey) {
    return Number.NaN
  }
  const match = HERMES_RUN_KEY_PATTERN.exec(runKey)
  if (!match) {
    return Number.NaN
  }
  const [, year, month, day, hour, minute, second] = match
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
}

function mergeOutputAndSessionContent(
  outputContent: string | null,
  sessionContent: string | null
): string | null {
  if (!sessionContent) {
    return outputContent
  }
  if (!outputContent) {
    return `${FULL_SESSION_LOG_HEADING}\n\n${sessionContent}`
  }
  if (outputContent.includes(FULL_SESSION_LOG_HEADING)) {
    return outputContent
  }
  return `${outputContent}\n\n---\n\n${FULL_SESSION_LOG_HEADING}\n\n${sessionContent}`
}

export function mergeHermesOutputAndSessionRuns(
  outputRuns: unknown[],
  sessionRuns: unknown[]
): unknown[] {
  const sessionIndex = new HermesSessionRunIndex(
    outputRuns.length > 0 ? sessionRuns.map(getRunKey) : [],
    sortableTimeFromRunKey,
    MAX_SESSION_OUTPUT_GAP_MS
  )
  const usedSessionRunIndexes = sessionIndex.used
  const mergedOutputRuns = outputRuns.map((outputRun) => {
    if (!isRecord(outputRun)) {
      return outputRun
    }
    const sessionRunIndex = sessionIndex.find(getRunKey(outputRun))
    if (sessionRunIndex === null) {
      return outputRun
    }
    const sessionRun = sessionRuns[sessionRunIndex]
    if (!isRecord(sessionRun)) {
      return outputRun
    }
    sessionIndex.use(sessionRunIndex)
    return {
      ...outputRun,
      output_preview: getRunOutputPreview(outputRun) ?? getRunOutputPreview(sessionRun),
      output_content: mergeOutputAndSessionContent(
        getRunOutputContent(outputRun),
        getRunOutputContent(sessionRun)
      )
    }
  })
  return [
    ...mergedOutputRuns,
    ...sessionRuns.filter((_, index) => !usedSessionRunIndexes.has(index))
  ]
}

export function mergeHermesOutputAndSessionRunRefs(
  outputRefs: HermesOutputRunRef[],
  sessionRefs: HermesSessionRunRef[]
): HermesMergedRunRef[] {
  const sessionIndex = new HermesSessionRunIndex(
    outputRefs.length > 0 ? sessionRefs.map(getRunKey) : [],
    sortableTimeFromRunKey,
    MAX_SESSION_OUTPUT_GAP_MS
  )
  const usedSessionRunIndexes = sessionIndex.used
  const mergedOutputRefs = outputRefs.map((outputRef) => {
    const sessionRunIndex = sessionIndex.find(getRunKey(outputRef))
    const sessionRef = sessionRunIndex === null ? null : sessionRefs[sessionRunIndex]
    if (sessionRunIndex !== null) {
      sessionIndex.use(sessionRunIndex)
    }
    return {
      id: outputRef.id,
      job_id: outputRef.job_id,
      run_at: outputRef.run_at,
      run_key: outputRef.run_key,
      output: outputRef,
      session: sessionRef
    }
  })
  return [
    ...mergedOutputRefs,
    ...sessionRefs
      .filter((_, index) => !usedSessionRunIndexes.has(index))
      .map((sessionRef) => ({
        id: sessionRef.id,
        job_id: sessionRef.job_id,
        run_at: sessionRef.run_at,
        run_key: sessionRef.run_key,
        output: null,
        session: sessionRef
      }))
  ]
}
