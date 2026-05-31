/* eslint-disable max-lines -- Why: Hermes run history has to reconcile
 * markdown output files with SQLite session transcripts from separate stores. */
import { existsSync } from 'fs'
import { open, readdir, readFile, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import Database from '../sqlite/sync-database'

const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
const HERMES_OUTPUT_DIR = join(HERMES_HOME, 'cron', 'output')
const HERMES_STATE_DB = join(HERMES_HOME, 'state.db')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const HERMES_OUTPUT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/
const HERMES_RUN_KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/
const MAX_SESSION_OUTPUT_GAP_MS = 24 * 60 * 60 * 1000
const MAX_REFERENCED_LOG_BYTES = 5 * 1024 * 1024
const FULL_SESSION_LOG_HEADING = '## Full session log'
const REFERENCED_LOG_HEADING = '## Latest log file'
const LATEST_LOG_PATH_PATTERN =
  /\bLatest log path:\s*(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n]*?)(?=\s+Run summary:|\r?\n|$)/i

export type HermesCronOutputRunsPage = {
  total: number
  runs: unknown[]
}

type HermesOutputRunRef = {
  kind: 'output'
  id: string
  job_id: string
  run_at: string | null
  run_key: string | null
  output_path: string
}

type HermesSessionRunRef = {
  kind: 'session'
  id: string
  job_id: string
  run_at: string | null
  run_key: string | null
}

type HermesMergedRunRef = {
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function runAtFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function runKeyFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}${month}${day}_${hour}${minute}${second}`
}

function runAtFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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

function escapeSqlLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function cleanRunPreview(value: string): string | null {
  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>()]/g, ' ')
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return null
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}

function parseHermesOutput(content: string): {
  status: 'completed' | 'failed' | 'unknown'
  outputPreview: string | null
  outputContent: string
  error: string | null
} {
  const failed = /^#\s+Cron Job:.*\(FAILED\)/m.test(content) || /^##\s+Error\b/m.test(content)
  const errorMatch = /##\s+Error\s+```([\s\S]*?)```/m.exec(content)
  const responseMatch = /##\s+Response\s+([\s\S]*)$/m.exec(content)
  const error = errorMatch ? cleanRunPreview(errorMatch[1]) : null
  return {
    status: failed ? 'failed' : responseMatch ? 'completed' : 'unknown',
    outputPreview: cleanRunPreview(responseMatch?.[1] ?? errorMatch?.[1] ?? content),
    outputContent: content,
    error
  }
}

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

async function appendReferencedLogFile(content: string): Promise<string> {
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

function formatSessionMessages(messages: Record<string, unknown>[]): string | null {
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
  if (exactMatchIndex >= 0) {
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

function mergeHermesOutputAndSessionRuns(outputRuns: unknown[], sessionRuns: unknown[]): unknown[] {
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

function mergeHermesOutputAndSessionRunRefs(
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

export async function readHermesCronOutputRuns(jobId: string): Promise<unknown[]> {
  return (await readHermesCronOutputRunsPage(jobId, { page: 1, pageSize: Number.MAX_SAFE_INTEGER }))
    .runs
}

async function readHermesCronOutputRunRefs(jobId: string): Promise<HermesMergedRunRef[]> {
  const outputRuns = await readHermesOutputFileRunRefs(jobId)
  return mergeHermesOutputAndSessionRunRefs(outputRuns, readHermesSessionDbRunRefs(jobId)).sort(
    (a, b) => {
      const aTime = getRawRunTime(a)
      const bTime = getRawRunTime(b)
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
        return bTime - aTime
      }
      return getRawRunId(b).localeCompare(getRawRunId(a))
    }
  )
}

// Why: opening the Automations page calls readHermesCronOutputRunsPage with
// pageSize:0 once per local Hermes job to populate badge counts. Without a
// cache this performs N readdir + N sqlite open/query on every list call,
// which scales linearly with job and run-history size on the main process.
const HERMES_RUN_COUNT_CACHE_TTL_MS = 2000
type HermesRunCountCacheEntry = {
  promise: Promise<number>
  expiresAt: number
}
const hermesRunCountCache = new Map<string, HermesRunCountCacheEntry>()

export function clearHermesCronOutputRunCountCache(jobId?: string): void {
  if (jobId) {
    hermesRunCountCache.delete(jobId)
    return
  }
  hermesRunCountCache.clear()
}

async function readHermesCronOutputRunCount(jobId: string): Promise<number> {
  const now = Date.now()
  const cached = hermesRunCountCache.get(jobId)
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }
  const entry: HermesRunCountCacheEntry = {
    promise: readHermesCronOutputRunRefs(jobId).then((refs) => refs.length),
    expiresAt: Number.POSITIVE_INFINITY
  }
  hermesRunCountCache.set(jobId, entry)
  try {
    const count = await entry.promise
    entry.expiresAt = Date.now() + HERMES_RUN_COUNT_CACHE_TTL_MS
    return count
  } catch (error) {
    if (hermesRunCountCache.get(jobId) === entry) {
      hermesRunCountCache.delete(jobId)
    }
    throw error
  }
}

async function hydrateHermesRunRef(jobId: string, ref: HermesMergedRunRef): Promise<unknown> {
  const outputRun = ref.output ? await readHermesOutputFileRun(ref.output) : null
  const sessionRun = ref.session ? readHermesSessionDbRunById(jobId, ref.session.id) : null
  return (
    mergeHermesOutputAndSessionRuns(
      outputRun ? [outputRun] : [],
      sessionRun ? [sessionRun] : []
    )[0] ??
    outputRun ??
    sessionRun ??
    ref
  )
}

export async function readHermesCronOutputRunsPage(
  jobId: string,
  {
    page,
    pageSize
  }: {
    page: number
    pageSize: number
  }
): Promise<HermesCronOutputRunsPage> {
  if (!EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
    return { total: 0, runs: [] }
  }
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(0, Math.floor(pageSize))
  if (safePageSize === 0) {
    // Why: manager listing only needs a badge count; hydrating markdown logs
    // and full session transcripts can make opening Automations very slow.
    return { total: await readHermesCronOutputRunCount(jobId), runs: [] }
  }
  const runRefs = await readHermesCronOutputRunRefs(jobId)
  const start = (safePage - 1) * safePageSize
  const pageRefs = runRefs.slice(start, start + safePageSize)
  return {
    total: runRefs.length,
    runs: await Promise.all(pageRefs.map((ref) => hydrateHermesRunRef(jobId, ref)))
  }
}

function getRawRunId(run: unknown): string {
  if (typeof run === 'object' && run !== null && 'id' in run) {
    return String((run as { id: unknown }).id)
  }
  return ''
}

function getRawRunTime(run: unknown): number {
  if (typeof run !== 'object' || run === null || !('run_at' in run)) {
    return Number.NaN
  }
  const runAt = (run as { run_at: unknown }).run_at
  return typeof runAt === 'string' ? Date.parse(runAt) : Number.NaN
}

async function readHermesOutputFileRunRefs(jobId: string): Promise<HermesOutputRunRef[]> {
  const outputDir = join(HERMES_OUTPUT_DIR, jobId)
  if (!existsSync(outputDir)) {
    return []
  }
  const entries = await readdir(outputDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && HERMES_OUTPUT_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      kind: 'output' as const,
      id: `${jobId}:${entry.name}`,
      job_id: jobId,
      run_at: runAtFromHermesOutputFile(entry.name),
      run_key: runKeyFromHermesOutputFile(entry.name),
      output_path: join(outputDir, entry.name)
    }))
}

async function readHermesOutputFileRun(ref: HermesOutputRunRef): Promise<unknown> {
  try {
    const content = await readFile(ref.output_path, 'utf-8')
    const parsed = parseHermesOutput(content)
    const outputContent = await appendReferencedLogFile(parsed.outputContent)
    return {
      id: ref.id,
      job_id: ref.job_id,
      run_at: ref.run_at,
      run_key: ref.run_key,
      status: parsed.status,
      output_preview: parsed.outputPreview,
      output_content: outputContent,
      error: parsed.error,
      output_path: ref.output_path
    }
  } catch (error) {
    return {
      id: ref.id,
      job_id: ref.job_id,
      run_at: ref.run_at,
      run_key: ref.run_key,
      status: 'unknown',
      output_preview: null,
      output_content: null,
      error: error instanceof Error ? error.message : String(error),
      output_path: ref.output_path
    }
  }
}

function readHermesSessionDbRunRefs(jobId: string): HermesSessionRunRef[] {
  if (!existsSync(HERMES_STATE_DB)) {
    return []
  }
  try {
    const db = new Database(HERMES_STATE_DB, { readonly: true, fileMustExist: true })
    try {
      const pattern = `cron\\_${escapeSqlLike(jobId)}\\_%`
      const rows = db
        .prepare(
          `SELECT id, started_at
             FROM sessions
            WHERE id LIKE ? ESCAPE '\\'
            ORDER BY started_at DESC`
        )
        .all(pattern) as Record<string, unknown>[]
      return rows.map((row) => {
        const runId = typeof row.id === 'string' ? row.id : `${jobId}:${String(row.started_at)}`
        return {
          kind: 'session',
          id: runId,
          job_id: jobId,
          run_at: runAtFromUnixSeconds(row.started_at),
          run_key: runId.split(`${jobId}_`).at(-1) ?? null
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function readHermesSessionDbRunById(jobId: string, runId: string): unknown | null {
  if (!existsSync(HERMES_STATE_DB)) {
    return null
  }
  try {
    const db = new Database(HERMES_STATE_DB, { readonly: true, fileMustExist: true })
    try {
      const row = db
        .prepare(
          `SELECT id, title, started_at, ended_at, end_reason, model, message_count,
                  input_tokens, output_tokens, estimated_cost_usd
             FROM sessions
            WHERE id = ?`
        )
        .get(runId) as Record<string, unknown> | undefined
      if (!row) {
        return null
      }
      const messages = db
        .prepare(
          `SELECT role, content, tool_name, reasoning, reasoning_content
               FROM messages
              WHERE session_id = ?
              ORDER BY timestamp, id`
        )
        .all(runId) as Record<string, unknown>[]
      const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null
      const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null
      const messageCount = typeof row.message_count === 'number' ? row.message_count : null
      const tokenCount =
        (typeof row.input_tokens === 'number' ? row.input_tokens : 0) +
        (typeof row.output_tokens === 'number' ? row.output_tokens : 0)
      const summaryParts = [
        title,
        model ? `Model: ${model}` : null,
        messageCount !== null ? `${messageCount} messages` : null,
        tokenCount > 0 ? `${tokenCount} tokens` : null
      ].filter(Boolean)
      return {
        id: runId,
        job_id: jobId,
        run_at: runAtFromUnixSeconds(row.started_at),
        run_key: runId.split(`${jobId}_`).at(-1) ?? null,
        status: typeof row.ended_at === 'number' ? 'completed' : 'unknown',
        output_preview: summaryParts.join(' · ') || null,
        output_content: formatSessionMessages(messages),
        error: null,
        output_path: HERMES_STATE_DB
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
