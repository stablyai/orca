import { join } from 'node:path'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import { openJournalDatabase } from '../native-chat/agent-session-journal/database/journal-database'
import { openJournalDomainDatabase } from '../native-chat/agent-session-journal/database/journal-domain-database'
import { openWritableProfileStateDatabase } from '../persistence/profile-state/database/profile-state-database'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  readStoreSchemaSnapshot,
  type StoreSchemaSnapshot
} from './store-schema-snapshot.test-fixture'

export type FloorCheckedStore = 'profileState' | 'chatJournal' | 'chatDomain' | 'orchestration'
export type FloorStoreSchema = { userVersion: number; sql: readonly string[] }

type OpenedStore = { db: Database.Database; close: () => void }

const STORES: Record<FloorCheckedStore, { file: string; open: (path: string) => OpenedStore }> = {
  profileState: {
    file: 'profile-state.sqlite',
    open: (path) => {
      const { db } = openWritableProfileStateDatabase(path, 'floor-check')
      return { db, close: () => db.close() }
    }
  },
  chatJournal: {
    file: 'journal.sqlite',
    open: (path) => {
      const { db } = openJournalDatabase(path)
      return { db, close: () => db.close() }
    }
  },
  chatDomain: {
    file: 'journal-domain.sqlite',
    open: (path) => {
      const { db } = openJournalDomainDatabase(path)
      return { db, close: () => db.close() }
    }
  },
  orchestration: {
    file: 'orchestration.sqlite',
    open: (path) => {
      const orchestration = new OrchestrationDb(path)
      return { db: orchestration.db, close: () => orchestration.close() }
    }
  }
}

export const FLOOR_CHECKED_STORES: readonly FloorCheckedStore[] = [
  'profileState',
  'chatJournal',
  'chatDomain',
  'orchestration'
]

/** Tables, then their seeded rows, then everything else, so triggers never rewrite the captured rows. */
const replayRank = (sql: string): number =>
  /^\s*CREATE\s+TABLE\b/i.test(sql) ? 0 : /^\s*INSERT\b/i.test(sql) ? 1 : 2

/** Recreate the floor build's empty store from its CREATE statements. */
function writeFloorShapedStore(path: string, schema: FloorStoreSchema): void {
  const db = new Database(path)
  try {
    const ordered = schema.sql
      .map((sql, index) => ({ sql, index }))
      .sort((a, b) => replayRank(a.sql) - replayRank(b.sql) || a.index - b.index)
    db.exec(ordered.map(({ sql }) => `${sql};`).join('\n'))
    db.pragma(`user_version = ${schema.userVersion}`)
  } finally {
    db.close()
  }
}

/** Open a store the way the app does, fresh or over a floor-shaped file, and read its schema. */
export function readStoreSchemaAsOpened(
  store: FloorCheckedStore,
  dir: string,
  floorShapedFrom?: FloorStoreSchema
): StoreSchemaSnapshot {
  const path = join(dir, STORES[store].file)
  if (floorShapedFrom) {
    writeFloorShapedStore(path, floorShapedFrom)
  }
  const opened = STORES[store].open(path)
  try {
    return readStoreSchemaSnapshot(opened.db)
  } finally {
    opened.close()
  }
}

/** The floor build's own shape, read through the same normalizer. */
export function readFloorStoreSchema(dir: string, schema: FloorStoreSchema): StoreSchemaSnapshot {
  const path = join(dir, 'floor.sqlite')
  writeFloorShapedStore(path, schema)
  const db = new Database(path, { readonly: true })
  try {
    return readStoreSchemaSnapshot(db)
  } finally {
    db.close()
  }
}

const SCHEMA_ORDER: Record<string, number> = { table: 0, view: 1, index: 2, trigger: 3 }

const SchemaRow = z.object({ type: z.string(), name: z.string(), sql: z.string() })
const NamedRow = z.object({ name: z.string() })
const QuotedValuesRow = z.object({ v: z.string() })

/** Every CREATE statement and seeded row of a store, so a later build can recreate it exactly. */
function readStoreCreateStatements(db: Database.Database): FloorStoreSchema {
  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((row) => SchemaRow.parse(row))
  rows.sort((a, b) => SCHEMA_ORDER[a.type] - SCHEMA_ORDER[b.type] || a.name.localeCompare(b.name))
  const inserts: string[] = []
  for (const { name } of rows.filter((row) => row.type === 'table')) {
    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(name)
      .map((column) => `"${NamedRow.parse(column).name}"`)
    const values = db
      .prepare(
        `SELECT ${columns.map((column) => `quote(${column})`).join(" || ',' || ")} AS v FROM "${name}"`
      )
      .all()
    for (const row of values) {
      inserts.push(
        `INSERT INTO "${name}" (${columns.join(', ')}) VALUES (${QuotedValuesRow.parse(row).v})`
      )
    }
  }
  return {
    userVersion: Number(db.pragma('user_version', { simple: true })),
    sql: [...rows.map((row) => row.sql), ...inserts]
  }
}

/** The fixture a release becomes when it is the floor: each store as that release creates it. */
export function formatFloorStoreSchemas(dir: string): string {
  const stores = FLOOR_CHECKED_STORES.map((store) => {
    const path = join(dir, STORES[store].file)
    const opened = STORES[store].open(path)
    try {
      const { userVersion, sql } = readStoreCreateStatements(opened.db)
      const statements = sql.map((statement) => `      ${JSON.stringify(statement)}`).join(',\n')
      return `  "${store}": {\n    "userVersion": ${userVersion},\n    "sql": [\n${statements}\n    ]\n  }`
    } finally {
      opened.close()
    }
  })
  return `{\n${stores.join(',\n')}\n}\n`
}
