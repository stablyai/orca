import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { HERMES_STATE_DB } from './external-automation-storage-paths'
import type { HermesSessionRunRef } from './hermes-run-correlation'

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

const requireOptional = createRequire(__filename)
let databaseConstructor: DatabaseConstructor | null | undefined

function getDatabaseConstructor(): DatabaseConstructor | null {
  if (databaseConstructor !== undefined) {
    return databaseConstructor
  }
  try {
    const loaded = requireOptional('node:sqlite') as { DatabaseSync?: NodeSqliteDatabaseSync }
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

function escapeSqlLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function runAtFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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

export function readHermesSessionDbRunRefs(jobId: string): HermesSessionRunRef[] {
  if (!existsSync(HERMES_STATE_DB)) {
    return []
  }
  const Database = getDatabaseConstructor()
  if (!Database) {
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

export function readHermesSessionDbRunById(jobId: string, runId: string): unknown {
  if (!existsSync(HERMES_STATE_DB)) {
    return null
  }
  const Database = getDatabaseConstructor()
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
