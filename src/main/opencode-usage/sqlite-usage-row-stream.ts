import type Database from '../sqlite/sync-database'
import { UsageHistoryScanCapacityError } from '../usage-history-scan-budget'
import { columnExists, tableExists } from './schema-helpers'

export const OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES = 4 * 1024 * 1024

export type OpenCodeUsageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number | null
  data: string
  directory: string | null
  title: string | null
  worktree: string | null
  session_model: string | null
}

type OpenCodeSessionUsageRow = Omit<OpenCodeUsageRow, 'data'> & {
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
}

function retainedTextBytesSql(expressions: readonly string[]): string {
  return expressions
    .map((expression) => `length(CAST(COALESCE(${expression}, '') AS BLOB))`)
    .join(' + ')
}

function assertNoOversizedRows(
  db: Database.Database,
  fromSql: string,
  whereSql: string,
  rowBytesSql: string
): void {
  const oversized = db
    .prepare(
      `SELECT 1
       ${fromSql}
       WHERE ${whereSql}
         AND (${rowBytesSql}) > ${OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES}
       LIMIT 1`
    )
    .get()
  if (oversized) {
    throw new UsageHistoryScanCapacityError('retainedBytes', OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES)
  }
}

function assertNoOversizedJsonCandidates(
  db: Database.Database,
  table: 'message' | 'session_message',
  candidateWhereSql: string
): void {
  const oversized = db
    .prepare(
      `SELECT 1
       FROM ${table}
       WHERE ${candidateWhereSql}
         AND length(CAST(COALESCE(data, '') AS BLOB)) > ${OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES}
       LIMIT 1`
    )
    .get()
  if (oversized) {
    throw new UsageHistoryScanCapacityError('retainedBytes', OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES)
  }
}

function boundedJsonPredicate(dataExpression: string, predicate: string): string {
  return `CASE
    WHEN length(CAST(COALESCE(${dataExpression}, '') AS BLOB)) <= ${OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES}
    THEN (${predicate})
    ELSE 0
  END`
}

function getProjectJoin(db: Database.Database): string {
  return tableExists(db, 'project') && columnExists(db, 'session', 'project_id')
    ? 'LEFT JOIN project p ON p.id = s.project_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS worktree) p ON 1 = 0'
}

function getSessionModelSelect(db: Database.Database): string {
  return columnExists(db, 'session', 'model') ? 's.model AS session_model' : 'NULL AS session_model'
}

function getAssistantSessionMessageCount(db: Database.Database): number {
  if (!tableExists(db, 'session_message')) {
    return 0
  }
  const hasType = columnExists(db, 'session_message', 'type')
  assertNoOversizedJsonCandidates(db, 'session_message', hasType ? "type = 'assistant'" : '1 = 1')
  const jsonPredicate = boundedJsonPredicate(
    'data',
    "json_extract(data, '$.tokens.input') IS NOT NULL"
  )
  const assistantPredicate = hasType ? `type = 'assistant' AND ${jsonPredicate}` : jsonPredicate
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM session_message WHERE ${assistantPredicate}`)
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

function canReadSessionUsageRows(db: Database.Database): boolean {
  if (!tableExists(db, 'session')) {
    return false
  }
  return ['cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read'].every(
    (columnName) => columnExists(db, 'session', columnName)
  )
}

function getSessionUsageRowCount(db: Database.Database): number {
  if (!canReadSessionUsageRows(db)) {
    return 0
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM session
       WHERE tokens_input + tokens_output + tokens_reasoning + tokens_cache_read > 0`
    )
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

function* iterateSessionUsageRows(db: Database.Database): Iterable<OpenCodeUsageRow> {
  const projectJoin = getProjectJoin(db)
  const sessionModelSelect = getSessionModelSelect(db)
  const fromSql = `FROM session s ${projectJoin}`
  const whereSql = 's.tokens_input + s.tokens_output + s.tokens_reasoning + s.tokens_cache_read > 0'
  const rowBytesSql = retainedTextBytesSql([
    's.id',
    's.id',
    's.directory',
    's.title',
    'p.worktree',
    columnExists(db, 'session', 'model') ? 's.model' : "''"
  ])
  assertNoOversizedRows(db, fromSql, whereSql, rowBytesSql)

  const rows = db
    .prepare(
      `SELECT s.id, s.id AS session_id, s.time_created, s.time_updated,
              s.directory, s.title, p.worktree, ${sessionModelSelect},
              s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read
       ${fromSql}
       WHERE ${whereSql}
         AND (${rowBytesSql}) <= ${OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES}
       ORDER BY s.time_created, s.id`
    )
    .iterate() as Iterable<OpenCodeSessionUsageRow>

  for (const row of rows) {
    yield {
      id: row.id,
      session_id: row.session_id,
      time_created: row.time_created,
      time_updated: row.time_updated,
      directory: row.directory,
      title: row.title,
      worktree: row.worktree,
      session_model: row.session_model,
      data: JSON.stringify({
        cost: row.cost,
        tokens: {
          input: row.tokens_input,
          output: row.tokens_output,
          reasoning: row.tokens_reasoning,
          total: row.tokens_input + row.tokens_output + row.tokens_reasoning,
          cache: { read: row.tokens_cache_read, write: 0 }
        }
      })
    }
  }
}

function iterateMessageUsageRows(
  db: Database.Database,
  table: 'message' | 'session_message',
  assistantPredicate: string
): Iterable<OpenCodeUsageRow> {
  const alias = table === 'message' ? 'm' : 'sm'
  const projectJoin = getProjectJoin(db)
  const sessionModelSelect = getSessionModelSelect(db)
  const fromSql = `FROM ${table} ${alias} JOIN session s ON s.id = ${alias}.session_id ${projectJoin}`
  const rowBytesSql = retainedTextBytesSql([
    `${alias}.id`,
    `${alias}.session_id`,
    `${alias}.data`,
    's.directory',
    's.title',
    'p.worktree',
    columnExists(db, 'session', 'model') ? 's.model' : "''"
  ])
  assertNoOversizedRows(db, fromSql, assistantPredicate, rowBytesSql)

  return db
    .prepare(
      `SELECT ${alias}.id, ${alias}.session_id, ${alias}.time_created,
              ${alias}.time_updated, ${alias}.data,
              s.directory, s.title, p.worktree, ${sessionModelSelect}
       ${fromSql}
       WHERE ${assistantPredicate}
         AND (${rowBytesSql}) <= ${OPENCODE_USAGE_SQLITE_ROW_MAX_BYTES}
       ORDER BY ${alias}.time_created, ${alias}.id`
    )
    .iterate() as Iterable<OpenCodeUsageRow>
}

export function iterateOpenCodeUsageRows(db: Database.Database): Iterable<OpenCodeUsageRow> {
  if (!tableExists(db, 'session')) {
    return []
  }
  if (getSessionUsageRowCount(db) > 0) {
    return iterateSessionUsageRows(db)
  }

  if (getAssistantSessionMessageCount(db) > 0) {
    const assistantPredicate = columnExists(db, 'session_message', 'type')
      ? "sm.type = 'assistant'"
      : boundedJsonPredicate('sm.data', "json_extract(sm.data, '$.tokens.input') IS NOT NULL")
    return iterateMessageUsageRows(db, 'session_message', assistantPredicate)
  }

  if (!tableExists(db, 'message')) {
    return []
  }
  assertNoOversizedJsonCandidates(db, 'message', '1 = 1')
  return iterateMessageUsageRows(
    db,
    'message',
    boundedJsonPredicate('m.data', "json_extract(m.data, '$.role') = 'assistant'")
  )
}
