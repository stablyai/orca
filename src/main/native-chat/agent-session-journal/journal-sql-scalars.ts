import type { JournalSqlScope } from './journal-sql-scope'

type ScalarKind = 'integer' | 'boolean' | 'text' | 'json'

/** One typed column per fixed-size fact; each owner reads and writes only its own fields. */
const SCALAR_COLUMNS = {
  reducer: {
    contextBoundary: 'integer',
    lastSequence: 'integer',
    lastActivityAt: 'integer',
    oldestSequence: 'integer',
    highestFence: 'integer',
    latestAcceptedTurnSequence: 'integer',
    historyOrigin: 'json',
    derivedTurnScope: 'text'
  },
  queue: { revision: 'integer' },
  inputs: { revision: 'integer' },
  order: {
    reconstructing: 'boolean',
    receiptCount: 'integer',
    queueRevision: 'integer',
    revision: 'integer'
  },
  cards: {
    pauseKey: 'json',
    currentRevision: 'integer',
    initialized: 'boolean',
    floor: 'json',
    pauses: 'json',
    failed: 'boolean'
  },
  evidence: { nextOrdinal: 'integer' },
  links: { revision: 'integer', acceptedHandoverAt: 'integer' },
  lineage: { base: 'integer', clock: 'integer' },
  'newest-turn': { boundary: 'integer' },
  'pause-marks': {
    stopVersion: 'integer',
    clearVersion: 'integer',
    header: 'json',
    encoded: 'text'
  }
} as const satisfies Record<string, Record<string, ScalarKind>>

export type JournalSqlScalarOwner = keyof typeof SCALAR_COLUMNS

type ScalarColumn = { kind: ScalarKind; select: string; upsert: string }

function columnName(owner: string, name: string): string {
  return `${owner}_${name}`.replaceAll('-', '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

const SQL_TYPES: Record<ScalarKind, string> = {
  integer: 'INTEGER',
  boolean: 'INTEGER',
  text: 'TEXT',
  json: 'TEXT'
}

const columns = new Map<string, ScalarColumn>()
for (const [owner, fields] of Object.entries(SCALAR_COLUMNS)) {
  for (const [name, kind] of Object.entries(fields)) {
    const column = columnName(owner, name)
    columns.set(`${owner}\0${name}`, {
      kind,
      select: `SELECT ${column} AS value FROM journal_proj_sessions WHERE session_id=? AND epoch=?`,
      upsert: `INSERT INTO journal_proj_sessions (session_id, epoch, ${column}) VALUES (?, ?, ?)
        ON CONFLICT(session_id, epoch) DO UPDATE SET ${column}=excluded.${column}`
    })
  }
}

export function journalSqlScalarSchema(): string {
  const defs = Object.entries(SCALAR_COLUMNS).flatMap(([owner, fields]) =>
    Object.entries(fields).map(([name, kind]) => `  ${columnName(owner, name)} ${SQL_TYPES[kind]},`)
  )
  return `
CREATE TABLE IF NOT EXISTS journal_proj_sessions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
${defs.join('\n')}
  PRIMARY KEY (session_id, epoch)
);
`
}

/** Fixed-size facts: read once per command on first use, written through on every change. */
export class JournalSqlScalars {
  private readonly cache = new Map<string, unknown>()

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly owner: JournalSqlScalarOwner
  ) {}

  get<T>(name: string, fallback: T): T {
    if (!this.cache.has(name)) {
      const column = this.column(name)
      const row = this.scope.db.prepare(column.select).get(...this.scope.prefix)
      const stored = row?.value ?? null
      this.cache.set(
        name,
        stored === null ? fallback : this.decode(column.kind, this.scope.examined(row!).value)
      )
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each owner reads back the typed value it stored under that name.
    return this.cache.get(name) as T
  }

  set(name: string, value: unknown): void {
    const column = this.column(name)
    this.cache.set(name, value)
    this.scope.db.prepare(column.upsert).run(...this.scope.prefix, encode(column.kind, value))
  }

  /** Defines accessor properties so reducer code keeps its plain field reads and writes. */
  define<T extends object, S extends object>(target: T, defaults: S): T & S {
    for (const [name, fallback] of Object.entries(defaults)) {
      Object.defineProperty(target, name, {
        enumerable: true,
        get: () => this.get(name, fallback),
        set: (value: unknown) => {
          this.set(name, value)
        }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key of defaults was just defined on target as an accessor of its type.
    return target as T & S
  }

  private column(name: string): ScalarColumn {
    const column = columns.get(`${this.owner}\0${name}`)
    if (!column) {
      throw new Error(`Unknown journal scalar ${this.owner}.${name}`)
    }
    return column
  }

  private decode(kind: ScalarKind, value: unknown): unknown {
    switch (kind) {
      case 'integer':
        return Number(value)
      case 'boolean':
        return Number(value) !== 0
      case 'text':
        this.scope.work.decodedBytes += Buffer.byteLength(String(value))
        return String(value)
      case 'json':
        return this.scope.decode(value)
    }
  }
}

function encode(kind: ScalarKind, value: unknown): number | string | null {
  switch (kind) {
    case 'integer':
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: integer columns hold the numeric fields their owners declare.
      return (value as number | null | undefined) ?? null
    case 'boolean':
      return value == null ? null : value ? 1 : 0
    case 'text':
      return value == null ? null : String(value)
    case 'json':
      // A stored JSON null reads back as null, not as the fallback, as before.
      return JSON.stringify(value ?? null)
  }
}
