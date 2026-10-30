import type Database from '../sqlite/sync-database'
import { columnExists, tableExists } from './schema-helpers'

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

type OpenCodeSessionUsageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number | null
  directory: string | null
  title: string | null
  worktree: string | null
  session_model: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
}

// OpenCode 2 freezes session after copying to session_v2; prioritize live rows without double-counting.
const SESSION_TABLES_BY_PRIORITY = ['session_v2', 'session'] as const

// Prefer live metadata; legacy rows fill NULLs using these defaults for absent columns.
const SESSION_METADATA_COLUMNS: Record<string, string> = {
  project_id: 'NULL',
  directory: 'NULL',
  title: 'NULL',
  model: 'NULL',
  time_created: '0',
  time_updated: 'NULL'
}

const SESSION_TOKEN_COLUMNS = [
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write'
] as const

// Merge usage per column, not per row.
const SESSION_USAGE_COLUMNS = ['cost', ...SESSION_TOKEN_COLUMNS] as const

const SESSION_TOKEN_TOTAL = SESSION_TOKEN_COLUMNS.map((name) => `s.${name}`).join(' + ')

type SessionContributor = { table: string; alias: string }

function columnRef(
  db: Database.Database,
  contributor: SessionContributor,
  name: string
): string | null {
  return columnExists(db, contributor.table, name) ? `${contributor.alias}.${name}` : null
}

// Frozen legacy metadata can outlive migration; use it only where live values are NULL.
function buildMetadataExpression(
  db: Database.Database,
  contributors: readonly SessionContributor[],
  name: string
): string {
  const fallback = SESSION_METADATA_COLUMNS[name] ?? 'NULL'
  const refs = contributors
    .map((contributor) => columnRef(db, contributor, name))
    .filter((ref) => ref !== null)
  if (refs.length === 0 || contributors.length === 1) {
    return refs[0] ?? fallback
  }
  const tail = fallback === 'NULL' ? [] : [fallback]
  return `COALESCE(${[...refs, ...tail].join(', ')})`
}

// Migration may drop undecodable messages, then live totals grow: each column’s MAX preserves
// the strongest recorded lower bound without a winning row zeroing other cost/token columns.
function buildUsageExpression(
  db: Database.Database,
  contributors: readonly SessionContributor[],
  name: string
): string {
  const refs = contributors
    .map((contributor) => columnRef(db, contributor, name))
    .filter((ref) => ref !== null)
  if (refs.length === 0 || contributors.length === 1) {
    return refs[0] ?? '0'
  }
  // Outer joins yield NULL for absent generations; SQLite scalar MAX propagates NULL.
  const guarded = refs.map((ref) => `COALESCE(${ref}, 0)`)
  return guarded.length === 1 ? (guarded[0] ?? '0') : `MAX(${guarded.join(', ')})`
}

function listSessionTables(db: Database.Database): string[] {
  return SESSION_TABLES_BY_PRIORITY.filter(
    (table) => tableExists(db, table) && columnExists(db, table, 'id')
  )
}

function buildSessionTableSelect(
  db: Database.Database,
  tables: readonly string[],
  index: number
): string {
  const table = tables[index] ?? ''
  // Higher-priority holders exclude this row, so only lower generations can contribute.
  const contributors: SessionContributor[] = [
    { table, alias: 't' },
    ...tables
      .slice(index + 1)
      .map((other, offset) => ({ table: other, alias: `o${index + offset + 1}` }))
  ]
  const columns = [
    ...Object.keys(SESSION_METADATA_COLUMNS).map(
      (name) => `${buildMetadataExpression(db, contributors, name)} AS ${name}`
    ),
    ...SESSION_USAGE_COLUMNS.map(
      (name) => `${buildUsageExpression(db, contributors, name)} AS ${name}`
    )
  ]
  const joins = contributors
    .slice(1)
    .map((other) => `LEFT JOIN ${other.table} ${other.alias} ON ${other.alias}.id = t.id`)
    .join(' ')
  // Each ID belongs to its highest-priority holder; lower selects exclude higher holders.
  const exclusions = tables
    .slice(0, index)
    .map((other) => `NOT EXISTS (SELECT 1 FROM ${other} o WHERE o.id = t.id)`)
    .join(' AND ')
  return `SELECT t.id, ${columns.join(', ')} FROM ${table} t${joins ? ` ${joins}` : ''}${exclusions ? ` WHERE ${exclusions}` : ''}`
}

function buildSessionSource(db: Database.Database, tables: readonly string[]): string {
  const selects = tables.map((_table, index) => buildSessionTableSelect(db, tables, index))
  return `(${selects.join(' UNION ALL ')})`
}

function getProjectJoin(db: Database.Database): string {
  return tableExists(db, 'project')
    ? 'LEFT JOIN project p ON p.id = s.project_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS worktree) p ON 1 = 0'
}

function getAssistantSessionMessageCount(db: Database.Database): number {
  if (!tableExists(db, 'session_message')) {
    return 0
  }
  const assistantPredicate = columnExists(db, 'session_message', 'type')
    ? "type = 'assistant' AND json_extract(data, '$.tokens.input') IS NOT NULL"
    : "json_extract(data, '$.tokens.input') IS NOT NULL"
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SQLite aggregate rows are validated by the typed count field below.
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM session_message WHERE ${assistantPredicate}`)
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

// One generation’s usage columns suffice because merging fills each column independently.
function hasSessionUsageColumns(db: Database.Database, tables: readonly string[]): boolean {
  return tables.some((table) =>
    ['cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read'].every(
      (columnName) => columnExists(db, table, columnName)
    )
  )
}

function getSessionUsageRowCount(db: Database.Database, sessionSource: string): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SQLite aggregate rows are validated by the typed count field below.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${sessionSource} s
       WHERE ${SESSION_TOKEN_TOTAL} > 0`
    )
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

function selectSessionUsageRows(db: Database.Database, sessionSource: string): OpenCodeUsageRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT aliases match OpenCodeSessionUsageRow across supported schemas.
  const rows = db
    .prepare(
      `SELECT s.id, s.id AS session_id, s.time_created, s.time_updated,
              s.directory, s.title, p.worktree, s.model AS session_model,
              s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read,
              s.tokens_cache_write
       FROM ${sessionSource} s
       ${getProjectJoin(db)}
       WHERE ${SESSION_TOKEN_TOTAL} > 0
       ORDER BY s.time_created, s.id`
    )
    .all() as OpenCodeSessionUsageRow[]

  return rows.map((row) => ({
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
        total:
          row.tokens_input +
          row.tokens_output +
          row.tokens_reasoning +
          row.tokens_cache_read +
          row.tokens_cache_write,
        cache: {
          read: row.tokens_cache_read,
          write: row.tokens_cache_write
        }
      }
    })
  }))
}

export function selectUsageRows(db: Database.Database): OpenCodeUsageRow[] {
  const sessionTables = listSessionTables(db)
  if (sessionTables.length === 0) {
    return []
  }
  const sessionSource = buildSessionSource(db, sessionTables)

  // Session aggregates avoid parsing every message blob.
  if (hasSessionUsageColumns(db, sessionTables) && getSessionUsageRowCount(db, sessionSource) > 0) {
    return selectSessionUsageRows(db, sessionSource)
  }

  const projectJoin = getProjectJoin(db)

  if (getAssistantSessionMessageCount(db) > 0) {
    const assistantPredicate = columnExists(db, 'session_message', 'type')
      ? "sm.type = 'assistant'"
      : "json_extract(sm.data, '$.tokens.input') IS NOT NULL"
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT aliases match OpenCodeUsageRow across supported schemas.
    return db
      .prepare(
        `SELECT sm.id, sm.session_id, sm.time_created, sm.time_updated, sm.data,
                s.directory, s.title, p.worktree, s.model AS session_model
         FROM session_message sm
         JOIN ${sessionSource} s ON s.id = sm.session_id
         ${projectJoin}
         WHERE ${assistantPredicate}
         ORDER BY sm.time_created, sm.id`
      )
      .all() as OpenCodeUsageRow[]
  }

  if (!tableExists(db, 'message')) {
    return []
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT aliases match OpenCodeUsageRow across supported schemas.
  return db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data,
              s.directory, s.title, p.worktree, s.model AS session_model
       FROM message m
       JOIN ${sessionSource} s ON s.id = m.session_id
       ${projectJoin}
       WHERE json_extract(m.data, '$.role') = 'assistant'
       ORDER BY m.time_created, m.id`
    )
    .all() as OpenCodeUsageRow[]
}
