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

function findMatchingSessionRunIndex(
  outputRun: unknown,
  sessionRuns: unknown[],
  usedSessionRunIndexes: Set<number>
): number | null {
  const outputRunKey = getRunKey(outputRun)
  const exactMatchIndex = sessionRuns.findIndex(
    (sessionRun, index) =>
      !usedSessionRunIndexes.has(index) && getRunKey(sessionRun) === outputRunKey
  )
  if (exactMatchIndex !== -1) {
    return exactMatchIndex
  }
  const outputTime = sortableTimeFromRunKey(outputRunKey)
  if (!Number.isFinite(outputTime)) {
    return null
  }
  let bestIndex: number | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (let index = 0; index < sessionRuns.length; index += 1) {
    if (usedSessionRunIndexes.has(index)) {
      continue
    }
    const sessionTime = sortableTimeFromRunKey(getRunKey(sessionRuns[index]))
    if (!Number.isFinite(sessionTime)) {
      continue
    }
    const gap = outputTime - sessionTime
    if (gap < 0 || gap > MAX_SESSION_OUTPUT_GAP_MS || gap >= bestGap) {
      continue
    }
    bestIndex = index
    bestGap = gap
  }
  return bestIndex
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
  const usedSessionRunIndexes = new Set<number>()
  const mergedOutputRuns = outputRuns.map((outputRun) => {
    if (!isRecord(outputRun)) {
      return outputRun
    }
    const sessionRunIndex = findMatchingSessionRunIndex(
      outputRun,
      sessionRuns,
      usedSessionRunIndexes
    )
    if (sessionRunIndex === null) {
      return outputRun
    }
    const sessionRun = sessionRuns[sessionRunIndex]
    if (!isRecord(sessionRun)) {
      return outputRun
    }
    usedSessionRunIndexes.add(sessionRunIndex)
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
  const usedSessionRunIndexes = new Set<number>()
  const mergedOutputRefs = outputRefs.map((outputRef) => {
    const sessionRunIndex = findMatchingSessionRunIndex(
      outputRef,
      sessionRefs,
      usedSessionRunIndexes
    )
    const sessionRef = sessionRunIndex === null ? null : sessionRefs[sessionRunIndex]
    if (sessionRunIndex !== null) {
      usedSessionRunIndexes.add(sessionRunIndex)
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
