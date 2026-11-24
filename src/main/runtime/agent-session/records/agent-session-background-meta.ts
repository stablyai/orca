import type Database from '../../../sqlite/sync-database'
import type { StoredAgentSessionBackground } from './agent-session-tab-table'

/** A JSON list of open chats with no tab; older builds ignore it. */
const BACKGROUND_SESSIONS = 'background_sessions'
/** One key per bot chat a person ended, so ending or reopening one writes one row; older builds
 *  ignore them and see those chats as closed. */
const ENDED_SESSION = 'ended_session:'
/** The first key after every `ended_session:` one (';' follows ':'), for a range read on the key. */
const ENDED_SESSION_END = 'ended_session;'
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

function readSessionIdList(db: Database.Database, key: string): string[] {
  const value = readMeta(db, key)
  try {
    const ids: unknown = typeof value === 'string' ? JSON.parse(value) : []
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // An unreadable list only costs those chats their state: their mail waits, or an ended chat reads closed.
    return []
  }
}

export function readAgentSessionBackgroundMeta(
  db: Database.Database
): StoredAgentSessionBackground {
  return {
    ids: readSessionIdList(db, BACKGROUND_SESSIONS),
    backfilled: readMeta(db, BACKGROUND_SESSIONS_BACKFILLED) !== undefined,
    ended: db
      .prepare('SELECT key FROM agent_session_store_meta WHERE key >= ? AND key < ?')
      .all(ENDED_SESSION, ENDED_SESSION_END)
      .map((row) => String(row.key).slice(ENDED_SESSION.length))
  }
}

/** Most tab writes keep the background list (`background: null`); those writes skip it. */
export function writeAgentSessionBackgroundMeta(
  db: Database.Database,
  write: {
    background: string[] | null
    backgroundBackfilled: boolean
    ended?: { add: readonly string[]; remove: readonly string[] } | null
  }
): void {
  if (write.background) {
    writeMeta(
      db,
      BACKGROUND_SESSIONS,
      write.background.length > 0 ? JSON.stringify(write.background) : null
    )
  }
  for (const id of write.ended?.add ?? []) {
    writeMeta(db, `${ENDED_SESSION}${id}`, '1')
  }
  for (const id of write.ended?.remove ?? []) {
    writeMeta(db, `${ENDED_SESSION}${id}`, null)
  }
  if (write.backgroundBackfilled) {
    writeMeta(db, BACKGROUND_SESSIONS_BACKFILLED, '1')
  }
}
