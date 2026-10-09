import type Database from '../sqlite/sync-database'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import {
  agentSessionClosedOwnerKey,
  closedAgentSessionOwner,
  isReadableAgentSessionClosedOwner,
  type AgentSessionClosedOwner
} from './agent-session-closed-owner'

function parsed(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function closedOwnersTableExists(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_session_closed_owners') !== undefined
  )
}

/**
 * Created at EVERY writable open with no `user_version` bump (see `ensureQueuedMessagesTable`), and
 * run inside one transaction: no older build creates the table, so its absence is what says the
 * one-time migration has not run. Running it again would bring back a fact a receipt retired.
 */
export function ensureAgentSessionClosedOwnersTable(db: Database.Database): void {
  const migrated = closedOwnersTableExists(db)
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_session_closed_owners (
  owner_key  TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_session_records(session_id) ON DELETE CASCADE,
  fact_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_session_closed_owners_session
  ON agent_session_closed_owners (session_id);
`)
  if (!migrated) {
    migrateAgentSessionClosedOwnerRows(db)
  }
}

export function loadAgentSessionClosedOwnerRows(
  db: Database.Database
): Map<string, AgentSessionClosedOwner> {
  const facts = new Map<string, AgentSessionClosedOwner>()
  if (!closedOwnersTableExists(db)) {
    return facts
  }
  for (const row of db
    .prepare(
      'SELECT owner_key, session_id, fact_json FROM agent_session_closed_owners ORDER BY rowid'
    )
    .all()) {
    const fact = parsed(row.fact_json)
    if (
      typeof row.owner_key === 'string' &&
      isReadableAgentSessionClosedOwner(row.owner_key, fact) &&
      row.session_id === fact.sessionId
    ) {
      facts.set(row.owner_key, fact)
    }
  }
  return facts
}

export function writeAgentSessionClosedOwnerRows(
  db: Database.Database,
  writes: { upsert: [string, string][]; remove: string[] }
): void {
  for (const [key, json] of writes.upsert) {
    const fact = parsed(json)
    if (!isReadableAgentSessionClosedOwner(key, fact)) {
      throw new Error('agent_session_store_write_invalid')
    }
    db.prepare(
      'INSERT INTO agent_session_closed_owners (owner_key, session_id, fact_json) VALUES (?, ?, ?)'
    ).run(key, fact.sessionId, json)
  }
  for (const key of writes.remove) {
    db.prepare('DELETE FROM agent_session_closed_owners WHERE owner_key = ?').run(key)
  }
}

/** An older proof cannot recover a cleared process or past cutoff. */
function migrateAgentSessionClosedOwnerRows(db: Database.Database): void {
  for (const row of db.prepare('SELECT session_id, record_json FROM agent_session_records').all()) {
    const stored = parsed(row.record_json)
    if (!isPersistedAgentSessionRecord(stored) || stored.sessionId !== row.session_id) {
      continue
    }
    const { record } = decodePersistedAgentSessionRecord(stored)
    const evidence = record.lease.deathEvidence
    const fact =
      evidence?.ownerFence !== undefined && evidence.ownerFence <= record.lease.runtimeFence
        ? closedAgentSessionOwner(record, evidence)
        : null
    if (fact) {
      writeAgentSessionClosedOwnerRows(db, {
        upsert: [[agentSessionClosedOwnerKey(fact), JSON.stringify(fact)]],
        remove: []
      })
    }
  }
}
