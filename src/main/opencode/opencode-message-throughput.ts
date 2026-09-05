import SyncDatabase from '../sqlite/sync-database'
import { listOpenCodeDatabases } from '../opencode-usage/opencode-database-discovery'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import type { AgentMessageThroughput } from '../../shared/agent-throughput-types'

export type OpenCodeMessageThroughputRow = {
  id: string
  data: string | null
  time_created: number | null
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeMillis(value: unknown): number | null {
  const numeric = readCount(value)
  if (numeric <= 0) {
    return null
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric
}

function readModelLabel(data: Record<string, unknown>): string | null {
  const modelId =
    typeof data.modelID === 'string'
      ? data.modelID
      : typeof data.modelId === 'string'
        ? data.modelId
        : null
  const providerId =
    typeof data.providerID === 'string'
      ? data.providerID
      : typeof data.providerId === 'string'
        ? data.providerId
        : null
  if (!modelId) {
    return null
  }
  return providerId ? `${providerId}/${modelId}` : modelId
}

/** One assistant message row measured from its own `time.created` → `time.completed` span. */
export function measureOpenCodeMessageRow(
  row: OpenCodeMessageThroughputRow
): AgentMessageThroughput | undefined {
  const data = parseJsonObject(row.data)
  if (!data) {
    return undefined
  }
  const tokens = parseJsonObject(data.tokens)
  const time = parseJsonObject(data.time)
  const outputTokens = readCount(tokens?.output) + readCount(tokens?.reasoning)
  const startedAt = normalizeMillis(time?.created) ?? normalizeMillis(row.time_created)
  // Why: `completed` is stamped when the provider stream ends, so the span is the model call itself.
  const completedAt = normalizeMillis(time?.completed)
  if (outputTokens <= 0 || startedAt === null || completedAt === null) {
    return undefined
  }
  const generationMs = completedAt - startedAt
  if (!(generationMs > 0)) {
    return undefined
  }
  return { messageId: row.id, model: readModelLabel(data), outputTokens, generationMs, completedAt }
}

function selectNewestAssistantRows(
  db: SyncDatabase.Database,
  sessionId: string
): OpenCodeMessageThroughputRow[] {
  const table = tableExists(db, 'session_message')
    ? 'session_message'
    : tableExists(db, 'message')
      ? 'message'
      : null
  if (!table) {
    return []
  }
  const assistantPredicate = columnExists(db, table, 'type')
    ? "type = 'assistant'"
    : "json_extract(data, '$.role') = 'assistant'"
  // Why: the newest row can still be streaming (no `completed` yet); a short window finds the last finished one.
  return db
    .prepare(
      `SELECT id, data, time_created FROM ${table}
       WHERE session_id = ? AND ${assistantPredicate}
       ORDER BY time_created DESC, id DESC
       LIMIT 3`
    )
    .all(sessionId) as OpenCodeMessageThroughputRow[]
}

/** Throughput of the newest completed assistant message of an OpenCode session, read from its DB. */
export async function readLastOpenCodeMessageThroughput(
  sessionId: string,
  options: { databasePaths?: readonly string[] } = {}
): Promise<AgentMessageThroughput | undefined> {
  const databasePaths = options.databasePaths ?? (await listOpenCodeDatabases())
  for (const databasePath of databasePaths) {
    let db: SyncDatabase.Database | null = null
    try {
      db = new SyncDatabase(databasePath, { readonly: true, fileMustExist: true })
      for (const row of selectNewestAssistantRows(db, sessionId)) {
        const measured = measureOpenCodeMessageRow(row)
        if (measured) {
          return measured
        }
      }
    } catch {
      // Why: a DB mid-write or an older schema is not worth surfacing on every hook.
    } finally {
      db?.close()
    }
  }
  return undefined
}
