// How chats an older Orca wrote join this file: record, tab, chat-state row and upload claims.

import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'
import { readJournalStoreMeta, writeJournalStoreMeta } from './journal-store-meta'
import { olderOrcaRecordKeepingEditsHere } from './journal-legacy-record-edits'

type Claim = SqliteRow

/** The original's tabs and claims, and this file's tabs, read once per pass. */
export type Adoption = {
  savedTabs: Map<string, string>
  claims: Map<string, Claim[]>
  tabbed: Set<string>
  takenTabs: Set<string>
  nextPosition: number
  tabsRecorded: boolean
}

export function readAdoption(source: Database.Database, db: Database.Database): Adoption {
  const claims = new Map<string, Claim[]>()
  for (const claim of source
    .prepare('SELECT upload_id,session_id,claimed_at FROM agent_session_attachment_claims')
    .all()) {
    const id = String(claim.session_id)
    const list = claims.get(id) ?? []
    list.push(claim)
    claims.set(id, list)
  }
  const tabs = db.prepare('SELECT tab_id,session_id FROM agent_session_tabs').all()
  const tail = db.prepare('SELECT COALESCE(MAX(position),-1) AS tail FROM agent_session_tabs').get()
  return {
    savedTabs: new Map(
      source
        .prepare('SELECT tab_id,session_id FROM agent_session_tabs')
        .all()
        .map((row) => [String(row.session_id), String(row.tab_id)])
    ),
    claims,
    tabbed: new Set(tabs.map((row) => String(row.session_id))),
    takenTabs: new Set(tabs.map((row) => String(row.tab_id))),
    nextPosition: Number(tail?.tail ?? -1) + 1,
    tabsRecorded: readJournalStoreMeta(db, AGENT_SESSION_TABS_RECORDED) !== undefined
  }
}

/** The original's record, a tab and a catalog row, returning the record read; history converts lazily. */
export function adoptChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  as: string,
  adoption: Adoption
): string {
  const original = String(
    source.prepare('SELECT record_json FROM agent_session_records WHERE session_id=?').get(id)!
      .record_json
  )
  const record = as === id ? olderOrcaRecordKeepingEditsHere(db, id, original) : original
  // A copy takes its own id and starts its own provider conversation on its first send, as after
  // /clear: the original keeps its conversation, its owner and its /clear successor.
  db.prepare(`INSERT INTO agent_session_records(session_id,record_json) VALUES(?1,
    CASE WHEN ?1=?3 THEN ?2 ELSE json_remove(json_set(?2,'$.sessionId',?1,'$.lease.sessionId',?1,
      '$.providerHandleChain',json('[]'),'$.lease.claimStatus','released',
      '$.lease.ownerProcess',NULL,'$.lease.reservedSpawnToken',NULL,'$.lease.handoffStage',NULL,
      '$.lease.handoffOperationId',NULL,'$.lease.provenHandleLinkId',NULL,
      '$.lease.deathEvidence',NULL),
      '$.conversationCommand','$.providerContextBoundary','$.rewind','$.launchedAccount',
      '$.acquiredAccount') END)
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
  if (as === id && session) {
    db.prepare(
      'INSERT INTO journal_chat_state(session_id,workspace_id) VALUES(?,?) ON CONFLICT DO NOTHING'
    ).run(id, session.workspace_id)
  }
  if (as !== id) {
    insertClaims(db, as, adoption.claims.get(id) ?? [])
  }
  return original
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
  writeJournalStoreMeta(db, AGENT_SESSION_TABS_RECORDED, '1')
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
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
export function insertClaims(
  db: Database.Database,
  sessionId: string,
  claims: readonly Claim[]
): void {
  const insert = db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}
