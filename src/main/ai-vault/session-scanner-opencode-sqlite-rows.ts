import type { SqliteRow } from '../sqlite/sqlite-statement'
import type { SQLOutputValue } from 'node:sqlite'

type SessionRow = {
  id: string
  title: string | null
  directory: string | null
  time_created: number
  time_updated: number
  model_json: string | null
  agent: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  cost: number
  message_count: number
}

// Why guards and not casts: `SqliteStatement` hands back `Record<string, SQLOutputValue>`,
// so the column types are only a claim about the query until something checks them. A row
// from a schema that drifted, or from a database another tool wrote, reaches here too.
export function readPartDataRow(row: SqliteRow): { part_data: string } | null {
  return typeof row.part_data === 'string' ? { part_data: row.part_data } : null
}

export function readSessionRow(row: SqliteRow | undefined): SessionRow | null {
  if (!row || typeof row.id !== 'string') {
    return null
  }
  const text = (value: SQLOutputValue): string | null => (typeof value === 'string' ? value : null)
  const count = (value: SQLOutputValue): number => (typeof value === 'number' ? value : 0)
  return {
    id: row.id,
    title: text(row.title),
    directory: text(row.directory),
    time_created: count(row.time_created),
    time_updated: count(row.time_updated),
    model_json: text(row.model_json),
    agent: text(row.agent),
    tokens_input: count(row.tokens_input),
    tokens_output: count(row.tokens_output),
    tokens_reasoning: count(row.tokens_reasoning),
    tokens_cache_read: count(row.tokens_cache_read),
    cost: count(row.cost),
    message_count: count(row.message_count)
  }
}
