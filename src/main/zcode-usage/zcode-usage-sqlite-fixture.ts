import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

// The ZCode CLI schema as the app itself creates it, written out in full
// rather than trimmed to the columns a reader names: the reader probes for its
// columns, so a trimmed fixture would pass a probe the real database fails.

const SESSION_TABLE = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT,
    directory TEXT, path TEXT, title TEXT, version TEXT, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, revert TEXT, permission TEXT,
    time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER,
    task_type TEXT, title_source TEXT, title_message_id TEXT, time_title_updated INTEGER,
    trace_id TEXT, time_deleted INTEGER, last_outcome TEXT
  );
`

const MODEL_USAGE_TABLE = `
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT,
    turn_id TEXT, trace_id TEXT, span_id TEXT, assistant_message_id TEXT,
    parent_user_message_id TEXT, query_source TEXT, provider_id TEXT, model_id TEXT,
    variant TEXT, agent TEXT, mode TEXT, task_type TEXT, status TEXT,
    started_at INTEGER, first_token_at INTEGER, completed_at INTEGER, duration_ms INTEGER,
    time_to_first_token_ms INTEGER, finish_reason TEXT, tool_call_count INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    provider_total_tokens INTEGER, computed_total_tokens INTEGER, retry_count INTEGER,
    retryable INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER,
    error_type TEXT, error_code TEXT, error_message TEXT, raw_usage_json TEXT,
    provider_metadata_json TEXT
  );
`

export const ZCODE_USAGE_FIXTURE_EPOCH_MS = 1_792_800_000_000

export type ZcodeUsageFixtureUsage = {
  id: string
  sessionId: string
  /** `null` writes a NULL `model_id`; the parser then falls back to `provider_id`. */
  modelId?: string | null
  providerId?: string
  startedAt?: number
  completedAt?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  computedTotalTokens?: number | null
  status?: string
  taskType?: string
}

export type ZcodeUsageFixtureSpec = {
  sessions?: readonly {
    id: string
    directory?: string | null
    taskType?: string
    parentId?: string | null
  }[]
  usage?: readonly ZcodeUsageFixtureUsage[]
}

/**
 * Create a ZCode usage database at `dbPath`.
 * @param dbPath - Where to create the database; parent directories are created.
 * @param spec - The session and model_usage rows to write.
 */
export function writeZcodeUsageDatabase(dbPath: string, spec: ZcodeUsageFixtureSpec): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(SESSION_TABLE)
    db.exec(MODEL_USAGE_TABLE)
    for (const session of spec.sessions ?? []) {
      db.prepare(
        `INSERT INTO session (id, directory, task_type, parent_id, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        session.directory ?? null,
        session.taskType ?? 'interactive',
        session.parentId ?? null,
        ZCODE_USAGE_FIXTURE_EPOCH_MS,
        ZCODE_USAGE_FIXTURE_EPOCH_MS
      )
    }
    for (const usage of spec.usage ?? []) {
      db.prepare(
        `INSERT INTO model_usage (
           id, session_id, query_source, provider_id, model_id, task_type, status,
           started_at, completed_at, input_tokens, output_tokens, reasoning_tokens,
           cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
         ) VALUES (?, ?, 'main_turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        usage.id,
        usage.sessionId,
        usage.providerId ?? 'account:test-plan',
        usage.modelId === undefined ? 'GLM-5.3' : usage.modelId,
        usage.taskType ?? 'interactive',
        usage.status ?? 'completed',
        usage.startedAt ?? ZCODE_USAGE_FIXTURE_EPOCH_MS,
        usage.completedAt ?? ZCODE_USAGE_FIXTURE_EPOCH_MS + 1_000,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.reasoningTokens ?? 0,
        usage.cacheCreationInputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0,
        usage.computedTotalTokens === undefined ? null : usage.computedTotalTokens
      )
    }
  } finally {
    db.close()
  }
}
