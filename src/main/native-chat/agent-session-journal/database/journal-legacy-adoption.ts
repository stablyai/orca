import type Database from '../../../sqlite/sync-database'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { insertJournalLegacyClaims, missingJournalLegacyClaims } from './journal-legacy-claims'
import { runJournalTransaction } from './journal-database'
import { readMeta, writeMeta } from './journal-legacy-reconcile-marks'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'
import { journalLegacyChatRevision, journalLegacyChatRevisionKey } from './journal-legacy-source'

export type Claim = SqliteRow

/**
 * A baseline is the original's revision when it was read. A write changes the original's identity
 * for good, so while it still matches the saved receipt, no write followed any baseline here.
 */
export function missingBaselines(
  source: Database.Database,
  db: Database.Database
): [string, string][] {
  return journalLegacyOriginalChatIds(source, 'any')
    .filter((id) => readMeta(db, journalLegacyChatRevisionKey(id)) === undefined)
    .map((id): [string, string] => [id, journalLegacyChatRevision(source, id) ?? 'null'])
}

/** A stopped walk keeps the custody the bulk pass took before visiting any chat. */
export function retainEnumeratedClaims(db: Database.Database, adoption: Adoption): void {
  try {
    runJournalTransaction(db, () => {
      for (const [id, claims] of adoption.claims) {
        insertJournalLegacyClaims(db, id, missingJournalLegacyClaims(db, id, claims))
      }
    })
  } catch (error) {
    console.warn('[agent-session-journal] keeping original upload custody failed', error)
  }
}

/** Adoption takes chats in the original's saved order; in any order, the id index alone answers. */
export function journalLegacyOriginalChatIds(
  source: Database.Database,
  order: 'saved' | 'any'
): string[] {
  return source
    .prepare(
      order === 'saved'
        ? 'SELECT session_id FROM agent_session_records ORDER BY rowid'
        : 'SELECT session_id FROM agent_session_records'
    )
    .all()
    .map((row) => String(row.session_id))
}

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
  const claims = readJournalLegacyClaims(source, only)
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

/** The original's upload claims by chat, for only the given chats when listed. */
export function readJournalLegacyClaims(
  source: Database.Database,
  only: readonly string[] | null
): Map<string, Claim[]> {
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
  return claims
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

/** The original's record, a tab and a catalog row; history converts lazily as usual. */
export function adoptJournalLegacyChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  as: string,
  adoption: Adoption
): void {
  const record = String(
    source.prepare('SELECT record_json FROM agent_session_records WHERE session_id=?').get(id)!
      .record_json
  )
  // A copy takes its own id and leaves the original's /clear successor to the original.
  db.prepare(`INSERT INTO agent_session_records(session_id,record_json) VALUES(?1,
    CASE WHEN ?1=?3 THEN ?2 ELSE json_remove(json_set(?2,'$.sessionId',?1,'$.lease.sessionId',?1),
      '$.conversationCommand') END)
    ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json`).run(as, record, id)
  // The older build wrote this chat, so it is shown even if it was closed here.
  if (!adoption.tabsRecorded) {
    recordTabIndex(db, adoption)
  }
  const saved = as === id ? adoption.savedTabs.get(id) : undefined
  addTab(
    db,
    adoption,
    as,
    saved !== undefined && !adoption.takenTabs.has(saved) ? saved : structuredAgentSessionTabId(as)
  )
  const session = source
    .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id=?')
    .get(id)
  // A copy is cataloged unconverted too; its history converts from the original chat.
  if (session) {
    db.prepare(
      'INSERT INTO journal_chat_state(session_id,workspace_id) VALUES(?,?) ON CONFLICT DO NOTHING'
    ).run(as, session.workspace_id)
  }
  if (as !== id) {
    insertJournalLegacyClaims(db, as, adoption.claims.get(id) ?? [])
  }
}

/**
 * A file that never recorded its tab index shows chats by the ids its clients pass in, which a
 * kept chat can't be among. Recording the index with every chat here shown keeps what was shown.
 */
function recordTabIndex(db: Database.Database, adoption: Adoption): void {
  for (const { session_id: id } of db
    .prepare('SELECT session_id FROM agent_session_records')
    .all()) {
    addTab(db, adoption, String(id), structuredAgentSessionTabId(String(id)))
  }
  writeMeta(db, AGENT_SESSION_TABS_RECORDED, '1')
  adoption.tabsRecorded = true
}

function addTab(db: Database.Database, adoption: Adoption, sessionId: string, tab: string): void {
  if (adoption.tabbed.has(sessionId) || adoption.takenTabs.has(tab)) {
    return
  }
  db.prepare('INSERT INTO agent_session_tabs(tab_id,session_id,position) VALUES(?,?,?)').run(
    tab,
    sessionId,
    adoption.nextPosition
  )
  adoption.nextPosition += 1
  adoption.tabbed.add(sessionId)
  adoption.takenTabs.add(tab)
  adoption.added.push([sessionId, tab])
}
