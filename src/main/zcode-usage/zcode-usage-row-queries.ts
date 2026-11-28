import type Database from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'

export type ZcodeUsageRow = {
  session_id: string
  started_at: number | null
  completed_at: number | null
  model_id: string | null
  provider_id: string | null
  directory: string | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  computed_total_tokens: number | null
}

// Older CLIs may predate a column; each contributes a literal instead. The
// token columns are the ones the WHERE filter and the parser both read, so a
// missing one must read as 0 rather than NULL.
const TOKEN_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
] as const

const OPTIONAL_COLUMNS = [
  'started_at',
  'completed_at',
  'model_id',
  'provider_id',
  'computed_total_tokens'
] as const

const tokenColumnSet = new Set<string>(TOKEN_COLUMNS)

function columnSelection(db: Database.Database, name: string): string {
  if (!columnExists(db, 'model_usage', name)) {
    return tokenColumnSet.has(name) ? '0' : 'NULL'
  }
  return `m.${name}`
}

export function selectZcodeUsageRows(db: Database.Database): ZcodeUsageRow[] {
  if (!tableExists(db, 'model_usage') || !columnExists(db, 'model_usage', 'session_id')) {
    return []
  }
  if (
    !columnExists(db, 'model_usage', 'input_tokens') ||
    !columnExists(db, 'model_usage', 'output_tokens')
  ) {
    return []
  }

  const sessionHasDirectory =
    tableExists(db, 'session') &&
    columnExists(db, 'session', 'id') &&
    columnExists(db, 'session', 'directory')
  const sessionJoin = sessionHasDirectory
    ? 'LEFT JOIN session s ON s.id = m.session_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS directory) s ON 1 = 0'
  const tokenTotal = TOKEN_COLUMNS.map((name) => `COALESCE(${columnSelection(db, name)}, 0)`).join(
    ' + '
  )
  const startedAt = columnSelection(db, 'started_at')
  const selections = [
    'm.session_id',
    's.directory',
    ...OPTIONAL_COLUMNS.map((name) => `${columnSelection(db, name)} AS ${name}`),
    ...TOKEN_COLUMNS.map((name) => `${columnSelection(db, name)} AS ${name}`)
  ]

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT aliases match ZcodeUsageRow across supported schemas.
  return db
    .prepare(
      `SELECT ${selections.join(', ')}
       FROM model_usage m
       ${sessionJoin}
       WHERE ${tokenTotal} > 0
       ORDER BY ${startedAt}`
    )
    .all() as ZcodeUsageRow[]
}
