// Read-only outside observation of an arm's chat SQLite database: per-chat ready marks, page/WAL state and a held reader snapshot.
// Every connection opens with readOnly; nothing here writes to the profile or asks the app for timing.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DOMAIN_DB = 'agent-session-domain.db'
const JOURNAL_DB = 'agent-session-journal.db'

function findDatabase(userDataDir: string, name: string): string | null {
  for (const entry of readdirSync(userDataDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name && !entry.parentPath.includes(`${path.sep}home`)) {
      return path.join(entry.parentPath, entry.name)
    }
  }
  return null
}

/** Every SQLite file in the profile outside the isolated home, relative to it: which originals a conversion retained. */
export const seededDbFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(db|sqlite)$/.test(entry.name) &&
        !entry.parentPath.includes(`${path.sep}home`)
    )
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))

/** The store chat rows live in on this arm: the candidate's converted store when present, else the journal store both arms keep. */
export const chatDatabasePath = (userDataDir: string): string | null =>
  findDatabase(userDataDir, DOMAIN_DB) ?? findDatabase(userDataDir, JOURNAL_DB)

export const openReadOnly = (file: string): DatabaseSync =>
  new DatabaseSync(file, { readOnly: true, timeout: 2_000 })

export const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined

export type PageState = {
  pageSize: number
  pageCount: number
  freelistPages: number
  walBytes: number
  /** Rows under an epoch other than their chat's ready epoch; null on a store without epochs. */
  retiredEpochRows: number | null
}

/** One short read-only look at page, free-list and WAL state; `retired` adds a scan for retired-epoch rows. */
export function pageState(file: string, retired = false): PageState {
  const db = openReadOnly(file)
  try {
    const pragma = (name: string): number =>
      Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? Number.NaN)
    const epochs = hasTable(db, 'journal_chat_state') && hasTable(db, 'journal_items')
    return {
      pageSize: pragma('page_size'),
      pageCount: pragma('page_count'),
      freelistPages: pragma('freelist_count'),
      walBytes: statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0,
      retiredEpochRows:
        retired && epochs
          ? Number(
              db
                .prepare(`SELECT count(*) AS n FROM journal_items item JOIN journal_chat_state head
                  ON head.session_id=item.session_id WHERE head.epoch IS NOT NULL AND item.epoch<>head.epoch`)
                .get()?.n
            )
          : null
    }
  } finally {
    db.close()
  }
}

/** Hold one read snapshot, as a long reader would, until the returned release runs. */
export function holdReader(file: string): () => void {
  const db = openReadOnly(file)
  db.exec('BEGIN')
  db.prepare('SELECT count(*) FROM sqlite_schema').get()
  let held = true
  return () => {
    if (held) {
      held = false
      db.exec('COMMIT')
      db.close()
    }
  }
}

/** Where a chat stands on the candidate's epoch-installed ready boundary. */
export type ChatState = 'no-domain-database' | 'uncatalogued' | 'pending' | 'importing' | 'ready'
export const CHAT_STATE_CODE: Record<ChatState, number> = {
  'no-domain-database': Number.NaN,
  uncatalogued: -1,
  pending: 0,
  importing: 1,
  ready: 2
}

/**
 * Polls `journal_chat_state` for epochs installed since the last poll; a chat's ready time is the first poll that sees it,
 * so every ready mark is an upper bound with `resolutionMs` resolution. Start it before the launch it observes.
 */
export class ConversionObserver {
  readonly readyAt = new Map<string, number>()
  databaseSeenAt = Number.NaN
  catalogRows = 0
  private db: DatabaseSync | null = null
  /** The converted store is created beside the seeded journal store, in the same state directory. */
  private readonly file: string | null
  private slowestPollMs = 0
  private stopped = false
  private readonly loop: Promise<void>

  constructor(
    userDataDir: string,
    readonly everyMs = 25
  ) {
    const journal = findDatabase(userDataDir, JOURNAL_DB)
    this.file = journal ? path.join(path.dirname(journal), DOMAIN_DB) : null
    this.loop = this.run()
  }

  /** The converted store once it exists; null on an arm that never creates one. */
  get databaseFile(): string | null {
    return this.db ? this.file : null
  }

  get resolutionMs(): number {
    return this.everyMs + Math.ceil(this.slowestPollMs)
  }

  private connection(): DatabaseSync | null {
    if (!this.db) {
      if (!this.file || !existsSync(this.file)) {
        return null
      }
      try {
        const db = openReadOnly(this.file)
        if (!hasTable(db, 'journal_chat_state')) {
          db.close()
          return null
        }
        this.db = db
        this.databaseSeenAt = Date.now()
      } catch {
        return null
      }
    }
    return this.db
  }

  private poll(): void {
    const db = this.connection()
    if (!db) {
      return
    }
    const started = performance.now()
    try {
      const ready = db
        .prepare('SELECT session_id FROM journal_chat_state WHERE epoch IS NOT NULL')
        .all()
      const now = Date.now()
      for (const row of ready) {
        const id = String(row.session_id)
        if (!this.readyAt.has(id)) {
          this.readyAt.set(id, now)
        }
      }
      this.catalogRows = Number(db.prepare('SELECT count(*) AS n FROM journal_chat_state').get()?.n)
    } catch {
      // A busy or briefly locked store is retried on the next poll.
    }
    this.slowestPollMs = Math.max(this.slowestPollMs, performance.now() - started)
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.poll()
      // Unref'd: an observer left running never keeps the harness process alive.
      await new Promise((resolve) => setTimeout(resolve, this.everyMs).unref())
    }
  }

  /** Read one chat's state now, outside the poll. */
  state(sessionId: string): ChatState {
    const db = this.connection()
    if (!db) {
      return 'no-domain-database'
    }
    const head = db
      .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?')
      .get(sessionId)
    if (!head) {
      return 'uncatalogued'
    }
    if (head.epoch !== null) {
      this.readyAt.set(sessionId, this.readyAt.get(sessionId) ?? Date.now())
      return 'ready'
    }
    return db.prepare('SELECT 1 FROM journal_items WHERE session_id=? LIMIT 1').get(sessionId)
      ? 'importing'
      : 'pending'
  }

  /** Resolve once every listed chat was seen ready (true), or false at the deadline or without a domain database. */
  async allReady(sessionIds: readonly string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.connection()) {
        return false
      }
      if (sessionIds.every((id) => this.readyAt.has(id))) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, this.everyMs))
    }
    return false
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loop
    this.db?.close()
    this.db = null
  }
}
