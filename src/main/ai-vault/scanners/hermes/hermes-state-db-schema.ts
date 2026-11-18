import type SyncDatabase from '../../../sqlite/sync-database'
import { tableExists } from '../../../opencode-usage/schema-helpers'

// What a Hermes state.db holds: columns differ across releases, so every read asks this first.

const SESSION_COLUMNS = [
  'id',
  'parent_session_id',
  'started_at',
  'source',
  'session_key',
  'model',
  'model_config',
  'cwd',
  'title',
  'ended_at',
  'end_reason',
  'last_activity_at',
  'hidden',
  'archived',
  'transcript_revision'
] as const

export type HermesSessionRow = {
  id: string
  parent_session_id: string | null
  started_at: number
  source: string | null
  session_key: string | null
  model: string | null
  model_config: string | null
  cwd: string | null
  title: string | null
  ended_at: number | null
  end_reason: string | null
  last_activity_at: number | null
  hidden: number | null
  archived: number | null
  transcript_revision: number | null
}

/** Columns differ across Hermes releases (schema 4 had no cwd, hidden or archived); read them once per open. */
export type HermesSchema = {
  sessions: ReadonlySet<string>
  messages: ReadonlySet<string>
  messageIndexes: ReadonlySet<string>
  hasStateMeta: boolean
}

function tableColumns(db: SyncDatabase, table: string): Set<string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA table_info rows carry a name column.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

const schemaCache = new Map<string, { version: number; schema: HermesSchema | null }>()

/** Null when the database is not a readable Hermes session store. Cached per store until its
 *  schema_version moves: the column probes cost more than a whole preview read. */
export function readHermesSchema(db: SyncDatabase, dbPath: string): HermesSchema | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA schema_version returns one integer row.
  const version = (db.prepare('PRAGMA schema_version').get() as { schema_version: number })
    .schema_version
  const cached = schemaCache.get(dbPath)
  if (cached?.version === version) {
    return cached.schema
  }
  const schema = probeHermesSchema(db)
  schemaCache.delete(dbPath)
  schemaCache.set(dbPath, { version, schema })
  if (schemaCache.size > 32) {
    schemaCache.delete(schemaCache.keys().next().value!)
  }
  return schema
}

function probeHermesSchema(db: SyncDatabase): HermesSchema | null {
  const sessions = tableColumns(db, 'sessions')
  const messages = tableColumns(db, 'messages')
  const required =
    ['id', 'parent_session_id', 'started_at'].every((column) => sessions.has(column)) &&
    ['id', 'session_id', 'role', 'content', 'timestamp'].every((column) => messages.has(column))
  if (!required) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA index_list rows carry a name column.
  const indexes = db.prepare('PRAGMA index_list(messages)').all() as { name?: unknown }[]
  return {
    sessions,
    messages,
    messageIndexes: new Set(
      indexes.flatMap((index) => (typeof index.name === 'string' ? [index.name] : []))
    ),
    hasStateMeta: tableExists(db, 'state_meta')
  }
}

export function sessionSelect(schema: HermesSchema): string {
  return SESSION_COLUMNS.map((column) =>
    schema.sessions.has(column) ? column : `NULL AS ${column}`
  ).join(', ')
}
