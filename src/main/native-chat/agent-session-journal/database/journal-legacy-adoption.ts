import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'
import { readMeta } from './journal-legacy-reconcile-marks'

export type Claim = SqliteRow

/** A Set over a walk's rows, or point reads over this file's own. */
type Lookup = {
  has(value: string): boolean
  add(value: string): unknown
  delete(value: string): unknown
}

/** The original's tabs and claims, and this file's tabs, read once per walk. */
export type Adoption = {
  savedTabs: Map<string, string>
  claims: Map<string, Claim[]>
  tabbed: Lookup
  takenTabs: Lookup
  nextPosition: number
  tabsRecorded: boolean
  /** Tabs this pass added, so a chat that fails can take back its own. */
  added: [sessionId: string, tab: string][]
}

/**
 * A pass over chats due a copy reads only those chats' claims and looks this file's tabs up one at a
 * time; a copy never takes the original's saved tab. Neither table is indexed by chat, so that pass
 * still scans the claims once and this file's tabs once per due chat, keeping only their rows.
 */
export function readAdoption(
  source: Database.Database,
  db: Database.Database,
  only: readonly string[] | null
): Adoption {
  const claims = new Map<string, Claim[]>()
  for (const claim of source
    .prepare(`SELECT upload_id,session_id,claimed_at FROM agent_session_attachment_claims
      WHERE ?1 IS NULL OR session_id IN (SELECT value FROM json_each(?1))`)
    .all(only && JSON.stringify(only))) {
    const id = String(claim.session_id)
    const list = claims.get(id) ?? []
    list.push(claim)
    claims.set(id, list)
  }
  const tail = db.prepare('SELECT COALESCE(MAX(position),-1) AS tail FROM agent_session_tabs').get()
  const tabsRecorded = readMeta(db, AGENT_SESSION_TABS_RECORDED) !== undefined
  // Recording the tab index adds one tab per record, so it takes this file's tabs as a set.
  const pointed = only !== null && tabsRecorded
  const tabs = pointed ? [] : db.prepare('SELECT tab_id,session_id FROM agent_session_tabs').all()
  return {
    savedTabs: new Map(
      only
        ? []
        : source
            .prepare('SELECT tab_id,session_id FROM agent_session_tabs')
            .all()
            .map((row) => [String(row.session_id), String(row.tab_id)])
    ),
    claims,
    tabbed: pointed
      ? tabLookup(db, 'session_id')
      : new Set(tabs.map((row) => String(row.session_id))),
    takenTabs: pointed ? tabLookup(db, 'tab_id') : new Set(tabs.map((row) => String(row.tab_id))),
    nextPosition: Number(tail?.tail ?? -1) + 1,
    tabsRecorded,
    added: []
  }
}

/** This file's own rows answer, so a tab added or rolled back needs no bookkeeping here. */
function tabLookup(db: Database.Database, column: 'session_id' | 'tab_id'): Lookup {
  const query = db.prepare(`SELECT 1 FROM agent_session_tabs WHERE ${column}=?`)
  return {
    has: (value) => query.get(value) !== undefined,
    add: () => undefined,
    delete: () => undefined
  }
}
