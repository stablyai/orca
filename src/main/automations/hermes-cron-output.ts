import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Database from '../sqlite/sync-database'
import {
  HERMES_OUTPUT_FILE_PATTERN,
  escapeSqlLike,
  parseHermesOutput,
  runAtFromHermesOutputFile,
  runAtFromUnixSeconds,
  runKeyFromHermesOutputFile
} from './hermes-cron-output-markdown'
import {
  appendReferencedLogFile,
  formatSessionMessages,
  mergeHermesOutputAndSessionRunRefs,
  mergeHermesOutputAndSessionRuns
} from './hermes-cron-run-content'
import {
  clearHermesCronOutputRunCountCache as clearHermesRunCountCache,
  readCachedHermesRunCount
} from './hermes-cron-run-count-cache'

const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
const HERMES_OUTPUT_DIR = join(HERMES_HOME, 'cron', 'output')
const HERMES_STATE_DB = join(HERMES_HOME, 'state.db')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export type HermesCronOutputRunsPage = {
  total: number
  runs: unknown[]
}

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
export function clearHermesCronOutputRunCountCache(jobId?: string): void {
  clearHermesRunCountCache(jobId)
}

async function readHermesCronOutputRunCount(jobId: string): Promise<number> {
  return readCachedHermesRunCount(jobId, async (targetJobId) => {
    const refs = await readHermesCronOutputRunRefs(targetJobId)
    return refs.length
  })
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

function readHermesSessionDbRunById(jobId: string, runId: string): unknown {
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
