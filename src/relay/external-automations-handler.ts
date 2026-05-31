/* eslint-disable max-lines -- Why: relay external automation listing, paginated
 * run history, and actions must stay co-located behind one relay request handler. */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { open, readdir, readFile, realpath, stat } from 'fs/promises'
import { createRequire } from 'module'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import type { RelayDispatcher } from './dispatcher'

const execFileAsync = promisify(execFile)
const requireOptional = createRequire(__filename)
const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
const HERMES_CRON_DIR = join(HERMES_HOME, 'cron')
const HERMES_JOBS_FILE = join(HERMES_CRON_DIR, 'jobs.json')
const HERMES_OUTPUT_DIR = join(HERMES_CRON_DIR, 'output')
const HERMES_STATE_DB = join(HERMES_HOME, 'state.db')
const OPENCLAW_JOBS_FILE = join(homedir(), '.openclaw', 'cron', 'jobs.json')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const HERMES_OUTPUT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/
const HERMES_RUN_KEY_PATTERN = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/
const MAX_SESSION_OUTPUT_GAP_MS = 24 * 60 * 60 * 1000
const MAX_REFERENCED_LOG_BYTES = 5 * 1024 * 1024
const FULL_SESSION_LOG_HEADING = '## Full session log'
const REFERENCED_LOG_HEADING = '## Latest log file'
const LATEST_LOG_PATH_PATTERN =
  /\bLatest log path:\s*(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n]*?)(?=\s+Run summary:|\r?\n|$)/i
type SqliteStatement = {
  get: (...args: unknown[]) => Record<string, unknown> | undefined
  all: (...args: unknown[]) => Record<string, unknown>[]
}
type SqliteDatabase = {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}
type DatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
) => SqliteDatabase
type NodeSqliteDatabaseSync = new (
  path: string,
  options?: { readOnly?: boolean; timeout?: number }
) => SqliteDatabase
let databaseConstructor: DatabaseConstructor | null | undefined

type ExternalProvider = 'hermes' | 'openclaw'
type HermesAction = 'pause' | 'resume' | 'run' | 'delete'
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
type HermesRunCountCacheEntry = {
  promise: Promise<number>
  expiresAt: number
}

const HERMES_RUN_COUNT_CACHE_TTL_MS = 2000

export class ExternalAutomationsHandler {
  private readonly hermesRunCountCache = new Map<string, HermesRunCountCacheEntry>()

  constructor(private readonly dispatcher: RelayDispatcher) {
    this.dispatcher.onRequest('externalAutomations.list', (params) => this.listJobs(params))
    this.dispatcher.onRequest('externalAutomations.runs', (params) => this.listRuns(params))
    this.dispatcher.onRequest('externalAutomations.create', (params) => this.createJob(params))
    this.dispatcher.onRequest('externalAutomations.update', (params) => this.updateJob(params))
    this.dispatcher.onRequest('externalAutomations.act', (params) => this.runAction(params))
  }

  private async isCommandAvailable(command: string): Promise<boolean> {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    try {
      await execFileAsync(finder, [command], {
        encoding: 'utf-8',
        timeout: 5000
      })
      return true
    } catch {
      return false
    }
  }

  private async readJobs(provider: ExternalProvider): Promise<unknown[]> {
    const jobsFile = provider === 'hermes' ? HERMES_JOBS_FILE : OPENCLAW_JOBS_FILE
    if (!existsSync(jobsFile)) {
      return []
    }
    const content = await readFile(jobsFile, 'utf-8')
    const parsed = JSON.parse(content) as unknown
    const jobs = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          Array.isArray((parsed as { jobs?: unknown }).jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : []
    if (provider !== 'hermes') {
      return jobs
    }
    return Promise.all(
      jobs.map(async (job) => {
        if (!this.isRecord(job) || typeof job.id !== 'string') {
          return job
        }
        const runsPage = await this.listRuns({
          provider: 'hermes',
          jobId: job.id,
          page: 1,
          pageSize: 0
        })
        return {
          ...job,
          run_count: runsPage.total,
          runs: runsPage.runs
        }
      })
    )
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private runAtFromHermesOutputFile(filename: string): string | null {
    const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
    if (!match) {
      return null
    }
    const [, year, month, day, hour, minute, second] = match
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`
  }

  private runKeyFromHermesOutputFile(filename: string): string | null {
    const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
    if (!match) {
      return null
    }
    const [, year, month, day, hour, minute, second] = match
    return `${year}${month}${day}_${hour}${minute}${second}`
  }

  private runAtFromUnixSeconds(value: unknown): string | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null
    }
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  private sortableTimeFromRunKey(runKey: string | null): number {
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

  private escapeSqlLike(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  }

  private cleanRunPreview(value: string): string | null {
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

  private parseHermesOutput(content: string): {
    status: 'completed' | 'failed' | 'unknown'
    outputPreview: string | null
    outputContent: string
    error: string | null
  } {
    const failed = /^#\s+Cron Job:.*\(FAILED\)/m.test(content) || /^##\s+Error\b/m.test(content)
    const errorMatch = /##\s+Error\s+```([\s\S]*?)```/m.exec(content)
    const responseMatch = /##\s+Response\s+([\s\S]*)$/m.exec(content)
    const error = errorMatch ? this.cleanRunPreview(errorMatch[1]) : null
    return {
      status: failed ? 'failed' : responseMatch ? 'completed' : 'unknown',
      outputPreview: this.cleanRunPreview(responseMatch?.[1] ?? errorMatch?.[1] ?? content),
      outputContent: content,
      error
    }
  }

  private extractLatestLogPath(content: string): string | null {
    const rawPath = LATEST_LOG_PATH_PATTERN.exec(content)?.groups?.path?.trim()
    if (!rawPath) {
      return null
    }
    return rawPath.replace(/^`|`$/g, '').trim()
  }

  private async readReferencedLogFile(content: string): Promise<{
    path: string
    content: string
    truncated: boolean
  } | null> {
    const logPath = this.extractLatestLogPath(content)
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
        await file.read(
          buffer,
          0,
          MAX_REFERENCED_LOG_BYTES,
          logStat.size - MAX_REFERENCED_LOG_BYTES
        )
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

  private async appendReferencedLogFile(content: string): Promise<string> {
    if (content.includes(REFERENCED_LOG_HEADING)) {
      return content
    }
    const logFile = await this.readReferencedLogFile(content)
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

  private formatSessionMessages(messages: Record<string, unknown>[]): string | null {
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

  private getRunKey(run: unknown): string | null {
    return this.isRecord(run) && typeof run.run_key === 'string' && run.run_key.trim()
      ? run.run_key
      : null
  }

  private getRunOutputContent(run: unknown): string | null {
    return this.isRecord(run) && typeof run.output_content === 'string' && run.output_content.trim()
      ? run.output_content
      : null
  }

  private getRunOutputPreview(run: unknown): string | null {
    return this.isRecord(run) && typeof run.output_preview === 'string' && run.output_preview.trim()
      ? run.output_preview
      : null
  }

  private mergeOutputAndSessionContent(
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

  private findMatchingSessionRunIndex(
    outputRun: unknown,
    sessionRuns: unknown[],
    usedSessionRunIndexes: Set<number>
  ): number | null {
    const outputRunKey = this.getRunKey(outputRun)
    const exactMatchIndex = sessionRuns.findIndex(
      (sessionRun, index) =>
        !usedSessionRunIndexes.has(index) && this.getRunKey(sessionRun) === outputRunKey
    )
    if (exactMatchIndex >= 0) {
      return exactMatchIndex
    }

    const outputTime = this.sortableTimeFromRunKey(outputRunKey)
    if (!Number.isFinite(outputTime)) {
      return null
    }

    let bestIndex: number | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (let index = 0; index < sessionRuns.length; index += 1) {
      if (usedSessionRunIndexes.has(index)) {
        continue
      }
      const sessionTime = this.sortableTimeFromRunKey(this.getRunKey(sessionRuns[index]))
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

  private mergeHermesOutputAndSessionRuns(
    outputRuns: unknown[],
    sessionRuns: unknown[]
  ): unknown[] {
    const usedSessionRunIndexes = new Set<number>()
    const mergedOutputRuns = outputRuns.map((outputRun) => {
      if (!this.isRecord(outputRun)) {
        return outputRun
      }
      const sessionRunIndex = this.findMatchingSessionRunIndex(
        outputRun,
        sessionRuns,
        usedSessionRunIndexes
      )
      if (sessionRunIndex === null) {
        return outputRun
      }
      const sessionRun = sessionRuns[sessionRunIndex]
      if (!this.isRecord(sessionRun)) {
        return outputRun
      }
      usedSessionRunIndexes.add(sessionRunIndex)
      // Hermes writes the markdown output at completion, while state.db keeps
      // the actual turn-by-turn transcript under the cron session start time.
      return {
        ...outputRun,
        output_preview: this.getRunOutputPreview(outputRun) ?? this.getRunOutputPreview(sessionRun),
        output_content: this.mergeOutputAndSessionContent(
          this.getRunOutputContent(outputRun),
          this.getRunOutputContent(sessionRun)
        )
      }
    })
    return [
      ...mergedOutputRuns,
      ...sessionRuns.filter((_, index) => !usedSessionRunIndexes.has(index))
    ]
  }

  private mergeHermesOutputAndSessionRunRefs(
    outputRefs: HermesOutputRunRef[],
    sessionRefs: HermesSessionRunRef[]
  ): HermesMergedRunRef[] {
    const usedSessionRunIndexes = new Set<number>()
    const mergedOutputRefs = outputRefs.map((outputRef) => {
      const sessionRunIndex = this.findMatchingSessionRunIndex(
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

  private getDatabaseConstructor(): DatabaseConstructor | null {
    if (databaseConstructor !== undefined) {
      return databaseConstructor
    }
    try {
      // Why: the remote relay still targets Node 18. Hosts without node:sqlite
      // should keep listing file-backed runs and simply omit DB transcripts.
      const loaded = requireOptional('node:sqlite') as {
        DatabaseSync?: NodeSqliteDatabaseSync
      }
      const DatabaseSync = loaded.DatabaseSync
      if (typeof DatabaseSync !== 'function') {
        databaseConstructor = null
        return databaseConstructor
      }
      const SqliteDatabaseSync = DatabaseSync
      databaseConstructor = class RelaySqliteDatabase {
        private readonly db: SqliteDatabase

        constructor(
          path: string,
          options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number } = {}
        ) {
          if (options.fileMustExist && !existsSync(path)) {
            throw new Error(`SQLite database does not exist: ${path}`)
          }
          this.db = new SqliteDatabaseSync(path, {
            readOnly: options.readonly,
            timeout: options.timeout
          })
        }

        prepare(sql: string): SqliteStatement {
          return this.db.prepare(sql)
        }

        close(): void {
          this.db.close()
        }
      }
    } catch {
      databaseConstructor = null
    }
    return databaseConstructor
  }

  private async readHermesRunRefs(jobId: string): Promise<HermesMergedRunRef[]> {
    const outputRuns = await this.readHermesOutputFileRunRefs(jobId)
    return this.mergeHermesOutputAndSessionRunRefs(
      outputRuns,
      this.readHermesSessionDbRunRefs(jobId)
    ).sort((a, b) => {
      const aTime = this.getRawRunTime(a)
      const bTime = this.getRawRunTime(b)
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
        return bTime - aTime
      }
      return this.getRawRunId(b).localeCompare(this.getRawRunId(a))
    })
  }

  private async hydrateHermesRunRef(jobId: string, ref: HermesMergedRunRef): Promise<unknown> {
    const outputRun = ref.output ? await this.readHermesOutputFileRun(ref.output) : null
    const sessionRun = ref.session ? this.readHermesSessionDbRunById(jobId, ref.session.id) : null
    return (
      this.mergeHermesOutputAndSessionRuns(
        outputRun ? [outputRun] : [],
        sessionRun ? [sessionRun] : []
      )[0] ??
      outputRun ??
      sessionRun ??
      ref
    )
  }

  private async readHermesRunCount(jobId: string): Promise<number> {
    if (!EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
      return 0
    }
    const now = Date.now()
    const cached = this.hermesRunCountCache.get(jobId)
    if (cached && cached.expiresAt > now) {
      return cached.promise
    }
    const entry: HermesRunCountCacheEntry = {
      promise: this.readHermesRunRefs(jobId).then((refs) => refs.length),
      expiresAt: Number.POSITIVE_INFINITY
    }
    this.hermesRunCountCache.set(jobId, entry)
    try {
      const count = await entry.promise
      entry.expiresAt = Date.now() + HERMES_RUN_COUNT_CACHE_TTL_MS
      return count
    } catch (error) {
      if (this.hermesRunCountCache.get(jobId) === entry) {
        this.hermesRunCountCache.delete(jobId)
      }
      throw error
    }
  }

  private clearHermesRunCountCache(jobId?: string): void {
    if (jobId) {
      this.hermesRunCountCache.delete(jobId)
      return
    }
    this.hermesRunCountCache.clear()
  }

  private async listRuns(params: Record<string, unknown> = {}): Promise<{
    total: number
    runs: unknown[]
  }> {
    const provider = params.provider === 'openclaw' ? 'openclaw' : 'hermes'
    const jobId = params.jobId
    const page =
      typeof params.page === 'number' && Number.isFinite(params.page)
        ? Math.max(1, Math.floor(params.page))
        : 1
    const pageSize =
      typeof params.pageSize === 'number' && Number.isFinite(params.pageSize)
        ? Math.min(100, Math.max(0, Math.floor(params.pageSize)))
        : 25
    if (provider !== 'hermes') {
      return { total: 0, runs: [] }
    }
    if (typeof jobId !== 'string' || !EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    if (pageSize === 0) {
      // Why: manager listing only needs a badge count; hydrating markdown logs
      // and full session transcripts can make opening Automations very slow.
      return { total: await this.readHermesRunCount(jobId), runs: [] }
    }
    const runRefs = await this.readHermesRunRefs(jobId)
    const start = (page - 1) * pageSize
    return {
      total: runRefs.length,
      runs: await Promise.all(
        runRefs.slice(start, start + pageSize).map((ref) => this.hydrateHermesRunRef(jobId, ref))
      )
    }
  }

  private getRawRunId(run: unknown): string {
    if (this.isRecord(run) && 'id' in run) {
      return String(run.id)
    }
    return ''
  }

  private getRawRunTime(run: unknown): number {
    if (!this.isRecord(run) || !('run_at' in run)) {
      return Number.NaN
    }
    return typeof run.run_at === 'string' ? Date.parse(run.run_at) : Number.NaN
  }

  private async readHermesOutputFileRunRefs(jobId: string): Promise<HermesOutputRunRef[]> {
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
        run_at: this.runAtFromHermesOutputFile(entry.name),
        run_key: this.runKeyFromHermesOutputFile(entry.name),
        output_path: join(outputDir, entry.name)
      }))
  }

  private async readHermesOutputFileRun(ref: HermesOutputRunRef): Promise<unknown> {
    try {
      const content = await readFile(ref.output_path, 'utf-8')
      const parsed = this.parseHermesOutput(content)
      const outputContent = await this.appendReferencedLogFile(parsed.outputContent)
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

  private readHermesSessionDbRunRefs(jobId: string): HermesSessionRunRef[] {
    if (!existsSync(HERMES_STATE_DB)) {
      return []
    }
    const Database = this.getDatabaseConstructor()
    if (!Database) {
      return []
    }
    try {
      const db = new Database(HERMES_STATE_DB, { readonly: true, fileMustExist: true })
      try {
        const pattern = `cron\\_${this.escapeSqlLike(jobId)}\\_%`
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
            run_at: this.runAtFromUnixSeconds(row.started_at),
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

  private readHermesSessionDbRunById(jobId: string, runId: string): unknown | null {
    if (!existsSync(HERMES_STATE_DB)) {
      return null
    }
    const Database = this.getDatabaseConstructor()
    if (!Database) {
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
          run_at: this.runAtFromUnixSeconds(row.started_at),
          run_key: runId.split(`${jobId}_`).at(-1) ?? null,
          status: typeof row.ended_at === 'number' ? 'completed' : 'unknown',
          output_preview: summaryParts.join(' · ') || null,
          output_content: this.formatSessionMessages(messages),
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

  private async listJobs(params?: Record<string, unknown>): Promise<{
    jobs: unknown[]
    hermesAvailable: boolean
    openclawAvailable: boolean
    error: string | null
  }> {
    const provider = params?.provider === 'openclaw' ? 'openclaw' : 'hermes'
    const [commandAvailable, jobsResult] = await Promise.allSettled([
      this.isCommandAvailable(provider),
      this.readJobs(provider)
    ])
    const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : []
    const available = commandAvailable.status === 'fulfilled' && commandAvailable.value
    return {
      jobs,
      hermesAvailable: provider === 'hermes' && available,
      openclawAvailable: provider === 'openclaw' && available,
      error: jobsResult.status === 'rejected' ? String(jobsResult.reason) : null
    }
  }

  private hermesCommand(action: HermesAction): string {
    switch (action) {
      case 'pause':
        return 'pause'
      case 'resume':
        return 'resume'
      case 'run':
        return 'run'
      case 'delete':
        return 'remove'
    }
  }

  private openClawCommand(action: HermesAction): string {
    switch (action) {
      case 'pause':
        return 'disable'
      case 'resume':
        return 'enable'
      case 'run':
        return 'run'
      case 'delete':
        return 'rm'
    }
  }

  private normalizeHermesJobMutation(params: Record<string, unknown>): {
    name: string
    prompt: string
    schedule: string
    workdir: string
  } {
    const provider = params.provider === 'openclaw' ? 'openclaw' : 'hermes'
    if (provider !== 'hermes') {
      throw new Error('Only Hermes cron creation and editing are supported.')
    }
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
    const schedule = typeof params.schedule === 'string' ? params.schedule.trim() : ''
    const workdir = typeof params.workdir === 'string' ? params.workdir.trim() : ''
    if (!prompt) {
      throw new Error('Hermes cron requires a prompt.')
    }
    if (!schedule) {
      throw new Error('Hermes cron requires a schedule.')
    }
    return {
      name: name || prompt.slice(0, 50).trim(),
      prompt,
      schedule,
      workdir
    }
  }

  private async runHermesCronCommand(args: string[]): Promise<void> {
    await execFileAsync('hermes', args, {
      encoding: 'utf-8',
      timeout: 30_000
    })
  }

  private async createJob(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const input = this.normalizeHermesJobMutation(params)
    const args = [
      'cron',
      'create',
      input.schedule,
      input.prompt,
      '--name',
      input.name,
      '--deliver',
      'local'
    ]
    if (input.workdir) {
      args.push('--workdir', input.workdir)
    }
    await this.runHermesCronCommand(args)
    this.clearHermesRunCountCache()
    return { ok: true }
  }

  private async updateJob(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const input = this.normalizeHermesJobMutation(params)
    const jobId = params.jobId
    if (typeof jobId !== 'string' || !EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    const args = [
      'cron',
      'edit',
      jobId,
      '--schedule',
      input.schedule,
      '--prompt',
      input.prompt,
      '--name',
      input.name
    ]
    if (input.workdir) {
      args.push('--workdir', input.workdir)
    }
    await this.runHermesCronCommand(args)
    this.clearHermesRunCountCache(jobId)
    return { ok: true }
  }

  private async runAction(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const provider = params.provider === 'openclaw' ? 'openclaw' : 'hermes'
    const action = params.action
    const jobId = params.jobId
    if (action !== 'pause' && action !== 'resume' && action !== 'run' && action !== 'delete') {
      throw new Error('Unsupported external automation action.')
    }
    if (typeof jobId !== 'string' || !EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    const command =
      provider === 'hermes' ? this.hermesCommand(action) : this.openClawCommand(action)
    await execFileAsync(provider, ['cron', command, jobId], {
      encoding: 'utf-8',
      timeout: 30_000
    })
    if (provider === 'hermes') {
      this.clearHermesRunCountCache(jobId)
    }
    return { ok: true }
  }
}
