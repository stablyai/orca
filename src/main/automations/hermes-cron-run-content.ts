import { open, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  FULL_SESSION_LOG_HEADING,
  LATEST_LOG_PATH_PATTERN,
  MAX_REFERENCED_LOG_BYTES,
  MAX_SESSION_OUTPUT_GAP_MS,
  REFERENCED_LOG_HEADING,
  asString,
  isRecord,
  sortableTimeFromRunKey
} from './hermes-cron-output-markdown'
import type {
  HermesMergedRunRef,
  HermesOutputRunRef,
  HermesSessionRunRef
} from './hermes-cron-output'

const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')

function extractLatestLogPath(content: string): string | null {
  const rawPath = LATEST_LOG_PATH_PATTERN.exec(content)?.groups?.path?.trim()
  if (!rawPath) {
    return null
  }
  return rawPath.replace(/^`|`$/g, '').trim()
}

async function readReferencedLogFile(content: string): Promise<{
  path: string
  content: string
  truncated: boolean
} | null> {
  const logPath = extractLatestLogPath(content)
  if (!logPath || !isAbsolute(logPath)) {
    return null
  }
  try {
    const homeRealPath = await realpath(HERMES_HOME)
    const logRealPath = await realpath(logPath)
    const relativeToHermesHome = relative(resolve(homeRealPath), resolve(logRealPath))
    // Why: the output body can contain agent-authored text, so only hydrate
    // referenced files that resolve inside Hermes' own data directory.
    if (
      relativeToHermesHome === '..' ||
      relativeToHermesHome.startsWith(`..${sep}`) ||
      isAbsolute(relativeToHermesHome)
    ) {
      return null
    }
    const logStat = await stat(logPath)
    if (!logStat.isFile()) {
      return null
    }
    if (logStat.size <= MAX_REFERENCED_LOG_BYTES) {
      return {
        path: logPath,
        content: await readFile(logPath, 'utf-8'),
        truncated: false
      }
    }
    const file = await open(logPath, 'r')
    try {
      const buffer = Buffer.alloc(MAX_REFERENCED_LOG_BYTES)
      await file.read(buffer, 0, MAX_REFERENCED_LOG_BYTES, logStat.size - MAX_REFERENCED_LOG_BYTES)
      return {
        path: logPath,
        content: buffer.toString('utf-8'),
        truncated: true
      }
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export async function appendReferencedLogFile(content: string): Promise<string> {
  if (content.includes(REFERENCED_LOG_HEADING)) {
    return content
  }
  const logFile = await readReferencedLogFile(content)
  if (!logFile) {
    return content
  }
  const note = logFile.truncated
    ? `Showing the last ${MAX_REFERENCED_LOG_BYTES} bytes because the log file is larger.`
    : null
  return [
    content,
    '---',
    REFERENCED_LOG_HEADING,
    '',
    `Path: ${logFile.path}`,
    note,
    '```text',
    logFile.content.trimEnd(),
    '```'
  ]
    .filter((part) => part !== null)
    .join('\n\n')
}

export function formatSessionMessages(messages: Record<string, unknown>[]): string | null {
  if (messages.length === 0) {
    return null
  }
  return messages
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'message'
      const content = typeof message.content === 'string' ? message.content.trim() : ''
      const toolName = typeof message.tool_name === 'string' ? message.tool_name.trim() : ''
      const reasoning =
        typeof message.reasoning_content === 'string'
          ? message.reasoning_content.trim()
          : typeof message.reasoning === 'string'
            ? message.reasoning.trim()
            : ''
      const parts = [
        `## ${role}${toolName ? ` / ${toolName}` : ''}`,
        reasoning ? `### Reasoning\n\n${reasoning}` : null,
        content || '(empty)'
      ].filter(Boolean)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')
}

function getRunKey(run: unknown): string | null {
  return isRecord(run) ? asString(run.run_key) : null
}

function getRunOutputContent(run: unknown): string | null {
  return isRecord(run) ? asString(run.output_content) : null
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
    // Hermes writes the markdown output at completion, while state.db keeps
    // the actual turn-by-turn transcript under the cron session start time.
    return {
      ...outputRun,
      output_preview: asString(outputRun.output_preview) ?? asString(sessionRun.output_preview),
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
