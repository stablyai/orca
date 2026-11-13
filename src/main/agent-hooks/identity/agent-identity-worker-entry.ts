import { randomUUID } from 'node:crypto'
import { parentPort } from 'node:worker_threads'

import SyncDatabase from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { createStructuredAgentSessionId } from '../../../shared/agent-session/structured-agent-session-create'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import type { AgentProviderKey } from './agent-provider-key'
import type {
  AgentIdentityWorkerRequest,
  AgentIdentityWorkerResponse
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

/** Orca ids for provider conversations, which nothing can rebuild: the file is never deleted, and
 *  an unreadable one throws so ids stay unavailable. A linked key is never relinked. Runs only in
 *  this worker, off the hook server's thread. */
export class AgentIdentityStore {
  private readonly db: SyncDatabase
  /** A newer build's file: existing ids resolve, nothing is minted. */
  readonly readOnly: boolean

  constructor(path: string, busyTimeoutMs = 25) {
    const opened = openIdentityDatabase(path, busyTimeoutMs)
    this.db = opened.db
    this.readOnly = opened.readOnly
    hardenSqliteDatabaseFiles(path)
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
    return request.kind === 'identify'
      ? { id: request.id, ok: true, value: opened.identify(request.key) }
      : { id: request.id, ok: true, value: opened.has(request.orcaSessionId) }
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
