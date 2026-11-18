import type Database from '../../../sqlite/sync-database'
import type { StoredAgentSessionBackground } from './agent-session-tab-table'

/** A JSON list of open chats with no tab; older builds ignore it. */
const BACKGROUND_SESSIONS = 'background_sessions'
/** TEMPORARY: marks the one-time background backfill done; delete with it after the next release. */
const BACKGROUND_SESSIONS_BACKFILLED = 'background_sessions_backfilled'

function readMeta(db: Database.Database, key: string): unknown {
  return db.prepare('SELECT value FROM agent_session_store_meta WHERE key = ?').get(key)?.value
}

/** Sets or, with null, removes one store meta key. */
function writeMeta(db: Database.Database, key: string, value: string | null): void {
  db.prepare(
    value === null
      ? 'DELETE FROM agent_session_store_meta WHERE key = ?1'
      : 'INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?1, ?2)'
  ).run(...(value === null ? [key] : [key, value]))
}

function readBackgroundSessionIds(db: Database.Database): string[] {
  const value = readMeta(db, BACKGROUND_SESSIONS)
  try {
    const ids: unknown = typeof value === 'string' ? JSON.parse(value) : []
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // An unreadable list only costs those chats their open state: their mail waits.
    return []
  }
}

export function readAgentSessionBackgroundMeta(
  db: Database.Database
): StoredAgentSessionBackground {
  return {
    ids: readBackgroundSessionIds(db),
    backfilled: readMeta(db, BACKGROUND_SESSIONS_BACKFILLED) !== undefined
  }
}

/** Most tab writes keep the background list (`background: null`); those writes skip it. */
export function writeAgentSessionBackgroundMeta(
  db: Database.Database,
  write: { background: string[] | null; backgroundBackfilled: boolean }
): void {
  if (write.background) {
    writeMeta(
      db,
      BACKGROUND_SESSIONS,
      write.background.length > 0 ? JSON.stringify(write.background) : null
    )
  }
  if (write.backgroundBackfilled) {
    writeMeta(db, BACKGROUND_SESSIONS_BACKFILLED, '1')
  }
}
