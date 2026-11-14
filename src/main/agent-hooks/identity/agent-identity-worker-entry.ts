import { randomUUID } from 'node:crypto'
import { parentPort } from 'node:worker_threads'

import SyncDatabase from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { createStructuredAgentSessionId } from '../../../shared/agent-session/structured-agent-session-create'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentProviderKey } from './agent-provider-key'
import {
  REVERSE_LOOKUP_UNAVAILABLE,
  type AgentIdentityWorkerRequest,
  type AgentIdentityWorkerResponse,
  type ReverseLookupUnavailable
} from './agent-identity-worker-protocol'

/** Bump only with additive DDL below; a newer file opens read-only, never rebuilt. */
const SCHEMA_VERSION = 1
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS identities(
  orca_session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_links(
  execution_host TEXT NOT NULL,
  wsl_distro TEXT NOT NULL,
  agent TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  orca_session_id TEXT NOT NULL REFERENCES identities(orca_session_id),
  UNIQUE(execution_host, wsl_distro, agent, provider_session_id, locator)
);`

const SELECT_LINK = `SELECT orca_session_id FROM provider_links
  WHERE execution_host = ? AND wsl_distro = ? AND agent = ? AND provider_session_id = ? AND locator = ?`
// Reverse lookups for `orca agent` reads: indexes only, so older builds open the file unchanged.
const LOOKUP_INDEX_SQL = `CREATE INDEX IF NOT EXISTS provider_links_by_orca_session
  ON provider_links(orca_session_id);
CREATE INDEX IF NOT EXISTS provider_links_by_provider_session
  ON provider_links(provider_session_id);`

type ReverseLookupColumn = 'orca_session_id' | 'provider_session_id'

const PROVIDER_SESSION_ID_MATCH_LIMIT = 8

function querySql(column: ReverseLookupColumn, index: string): string {
  const from = `FROM provider_links INDEXED BY ${quoteIdentifier(index)}`
  return column === 'orca_session_id'
    ? `SELECT execution_host, wsl_distro, agent, provider_session_id, locator ${from}
       WHERE orca_session_id = ? LIMIT 1`
    : `SELECT DISTINCT orca_session_id ${from}
       WHERE provider_session_id = ? LIMIT ${PROVIDER_SESSION_ID_MATCH_LIMIT}`
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** The reverse queries a provider-links table can answer by index search, never by a scan of
 *  every link. A candidate leads with the requested ordinary column under BINARY collation, and
 *  the exact query forced onto it (`INDEXED BY`) must plan as a SEARCH on that column: a partial
 *  index the query doesn't imply, a NOCASE one or a name alone never qualify. Checked once per
 *  schema version; the validated query is the one executed. */
class ReverseLookupQueries {
  private checked: { schema: number; sql: Map<ReverseLookupColumn, string | null> } | null = null

  constructor(
    private readonly db: SyncDatabase,
    /** Run once per schema version before inspecting, e.g. a writable file's own indexes. */
    private readonly prepareSchema: () => void
  ) {}

  /** The validated query for `column`, or null when no index can serve it. */
  sqlFor(column: ReverseLookupColumn): string | null {
    let schema = this.schemaVersion()
    if (this.checked?.schema !== schema) {
      this.prepareSchema()
      schema = this.schemaVersion()
      this.checked = { schema, sql: new Map() }
    }
    let sql = this.checked.sql.get(column)
    if (sql === undefined) {
      sql = this.find(column)
      this.checked.sql.set(column, sql)
    }
    return sql
  }

  private schemaVersion(): number {
    return Number(this.db.pragma('schema_version', { simple: true }))
  }

  private find(column: ReverseLookupColumn): string | null {
    for (const index of this.db.prepare('PRAGMA index_list(provider_links)').all()) {
      const name = String(index.name)
      const lead = this.db
        .prepare(`PRAGMA index_xinfo(${quoteIdentifier(name)})`)
        .all()
        .find((term) => Number(term.key) === 1)
      if (
        !lead ||
        Number(lead.seqno) !== 0 ||
        Number(lead.cid) < 0 ||
        lead.name !== column ||
        String(lead.coll).toUpperCase() !== 'BINARY'
      ) {
        continue
      }
      const sql = querySql(column, name)
      if (this.searches(sql, name, column)) {
        return sql
      }
    }
    return null
  }

  /** The forced plan searches `provider_links` by `column` and walks no table or index. */
  private searches(sql: string, index: string, column: ReverseLookupColumn): boolean {
    let plan: string[]
    try {
      plan = this.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all('')
        .map((row) => String(row.detail))
    } catch {
      // A partial index the query doesn't imply cannot be forced at all.
      return false
    }
    return (
      plan.some((detail) =>
        new RegExp(
          `^SEARCH provider_links USING (COVERING )?INDEX ${escapeRegExp(index)} \\(${column}=\\?`
        ).test(detail)
      ) && !plan.some((detail) => detail.startsWith('SCAN provider_links'))
    )
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Orca ids for provider conversations, which nothing can rebuild: the file is never deleted, and
 *  an unreadable one throws so ids stay unavailable. A linked key is never relinked. Runs only in
 *  this worker, off the hook server's thread. */
export class AgentIdentityStore {
  private readonly db: SyncDatabase
  /** A newer build's file: existing ids resolve, nothing is minted. */
  readonly readOnly: boolean

  /** Reverse lookups run only as an index search, never as a scan of every link. */
  private readonly reverse: ReverseLookupQueries

  constructor(path: string, busyTimeoutMs = 25) {
    const opened = openIdentityDatabase(path, busyTimeoutMs)
    this.db = opened.db
    this.readOnly = opened.readOnly
    hardenSqliteDatabaseFiles(path)
    // A writable file gets this build's indexes, and a busy one throws so the caller's failure
    // backoff retries it; a newer build's read-only file is used as it is.
    this.reverse = new ReverseLookupQueries(this.db, () => {
      if (!this.readOnly) {
        this.db.exec(LOOKUP_INDEX_SQL)
      }
    })
  }

  lookup(key: AgentProviderKey): OrcaSessionId | null {
    const row = this.db.prepare(SELECT_LINK).get(...keyBindings(key))
    const id = row?.orca_session_id
    return typeof id === 'string' && isOrcaSessionId(id) ? id : null
  }

  /** The key's id, minting one on first sighting (null only for an unlinked key in a read-only
   *  file); concurrent first sightings converge on the
   *  committed link. Throws on lock or I/O failure so callers retry later. */
  identify(key: AgentProviderKey): OrcaSessionId | null {
    const existing = this.lookup(key)
    if (existing || this.readOnly) {
      return existing
    }
    const minted = createStructuredAgentSessionId(key.agent, randomUUID)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO identities(orca_session_id, agent, created_at) VALUES (?, ?, ?)')
        .run(minted, key.agent, Date.now())
      const linked = this.db
        .prepare(
          `INSERT INTO provider_links(execution_host, wsl_distro, agent, provider_session_id, locator, orca_session_id)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
        )
        .run(...keyBindings(key), minted)
      // Another writer linked the key first: its id stands and this mint is dropped.
      if (Number(linked.changes) === 0) {
        this.db.prepare('DELETE FROM identities WHERE orca_session_id = ?').run(minted)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    }
    const committed = this.lookup(key)
    if (!committed) {
      throw new Error('agent identity link missing after commit')
    }
    return committed
  }

  /** Whether this host minted `id`; terminal identities are never chat records. */
  has(id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM identities WHERE orca_session_id = ?').get(id) !== undefined
    )
  }

  /** The provider conversation `id` names: each mint links exactly one key. */
  providerKeyOf(id: string): AgentProviderKey | null | ReverseLookupUnavailable {
    const sql = this.reverse.sqlFor('orca_session_id')
    if (!sql) {
      return REVERSE_LOOKUP_UNAVAILABLE
    }
    const row = this.db.prepare(sql).get(id)
    return row
      ? {
          executionHost: String(row.execution_host),
          wslDistro: String(row.wsl_distro),
          agent: String(row.agent),
          providerSessionId: String(row.provider_session_id),
          locator: String(row.locator)
        }
      : null
  }

  /** Orca ids linked to a provider's own session id, so a caller can be told which to use. */
  idsOfProviderSession(providerSessionId: string): OrcaSessionId[] | ReverseLookupUnavailable {
    const sql = this.reverse.sqlFor('provider_session_id')
    if (!sql) {
      return REVERSE_LOOKUP_UNAVAILABLE
    }
    return this.db
      .prepare(sql)
      .all(providerSessionId)
      .map((row) => row.orca_session_id)
      .filter((id): id is OrcaSessionId => typeof id === 'string' && isOrcaSessionId(id))
  }

  close(): void {
    this.db.close()
  }
}

/** Like the chat journal: migrate older files additively, open newer ones read-only. */
function openIdentityDatabase(
  path: string,
  busyTimeoutMs: number
): { db: SyncDatabase; readOnly: boolean } {
  const busyTimeout = `busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`
  const db = new SyncDatabase(path)
  let stored: number
  try {
    db.pragma(busyTimeout)
    stored = Number(db.pragma('user_version', { simple: true }))
  } catch (error) {
    db.close()
    throw error
  }
  if (stored > SCHEMA_VERSION) {
    db.close()
    const readOnly = new SyncDatabase(path, { readonly: true, fileMustExist: true })
    readOnly.pragma(busyTimeout)
    return { db: readOnly, readOnly: true }
  }
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    if (stored < SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(SCHEMA_SQL)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) {
          db.exec('ROLLBACK')
        }
        throw error
      }
    }
    return { db, readOnly: false }
  } catch (error) {
    db.close()
    throw error
  }
}

function keyBindings(key: AgentProviderKey): string[] {
  return [key.executionHost, key.wslDistro, key.agent, key.providerSessionId, key.locator]
}

let store: { path: string; store: AgentIdentityStore } | null = null

function storeFor(path: string): AgentIdentityStore {
  if (store?.path !== path) {
    store?.store.close()
    store = null
    store = { path, store: new AgentIdentityStore(path) }
  }
  return store.store
}

/** One request at a time: the client serializes calls through its queue. */
export function handleAgentIdentityRequest(
  request: AgentIdentityWorkerRequest
): AgentIdentityWorkerResponse {
  try {
    const opened = storeFor(request.path)
    switch (request.kind) {
      case 'identify':
        return { id: request.id, ok: true, value: opened.identify(request.key) }
      case 'has':
        return { id: request.id, ok: true, value: opened.has(request.orcaSessionId) }
      case 'providerKeyOf':
        return { id: request.id, ok: true, value: opened.providerKeyOf(request.orcaSessionId) }
      case 'idsOfProviderSession':
        return {
          id: request.id,
          ok: true,
          value: opened.idsOfProviderSession(request.providerSessionId)
        }
      case 'idsOfKeys':
        return {
          id: request.id,
          ok: true,
          value: request.keys.map((key) => opened.lookup(key) ?? '')
        }
    }
  } catch (error) {
    // A store that failed to open is reopened by the next request, never rebuilt.
    store?.store.close()
    store = null
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

const port = parentPort
if (port) {
  port.on('message', (request: AgentIdentityWorkerRequest) => {
    port.postMessage(handleAgentIdentityRequest(request))
  })
}
