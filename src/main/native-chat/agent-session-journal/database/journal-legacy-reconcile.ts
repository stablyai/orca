import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RestoredJournalDomainImport } from '../journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from '../journal-domain-import-rows'
import { runJournalTransaction } from './journal-database'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'
import { journalDatabasePath } from './journal-host-database'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey,
  openJournalLegacySource,
  recordJournalLegacyChatRevision
} from './journal-legacy-source'
import { readJournalStoreMeta, writeJournalStoreMeta } from './journal-store-meta'
import {
  captureJournalLegacySourceReceipt,
  JOURNAL_LEGACY_SOURCE_RECEIPT,
  journalLegacySourceLastRead,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'
import { olderMessageCursor, olderOrcaAddedMessages } from './journal-legacy-older-messages'
import { chatHistoryRestore } from './journal-legacy-message-compare'
import {
  applyOlderOrcaRecordEdits,
  takeOlderOrcaRecordEdits,
  JOURNAL_LEGACY_PERSON_EDITS_KEPT,
  keepJournalLegacyPersonEdits,
  olderOrcaRecordKeepingEditsHere,
  passOlderOrcaRecordEditsToCopy
} from './journal-legacy-record-edits'

/** Set after a pass absorbed every original chat, so each chat here carries its revision. */
export const JOURNAL_LEGACY_REVISIONS_KEPT = 'journal.legacy-revisions-kept.v1'

/**
 * An older Orca keeps writing the original journal after a downgrade. When the original changed,
 * each original chat's revision is compared with the one this file shows. A chat it started joins
 * as itself. One it added a real message to joins as itself when not converted here yet, or is
 * kept as a second chat beside a converted one, so no message it saved goes missing. Anything
 * else it wrote is taken as the new baseline, with the edits a person made to the chat's record.
 * Nothing here deletes a chat or its turns.
 */
export function reconcileJournalLegacySource(stateDirectory: string, db: Database.Database): void {
  const sourcePath = journalDatabasePath(stateDirectory)
  // Captured before reading, so a write during this pass is never taken as absorbed. Until every
  // chat here carries its revision (files converted before revisions were kept), each launch reads.
  const captured = captureJournalLegacySourceReceipt(sourcePath)
  if (captured.disposition === 'no-source-at-initialization') {
    return
  }
  const saved = readJournalStoreMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT)
  const unchanged = sameJournalLegacySource(saved, captured)
  const kept = readJournalStoreMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT) !== undefined
  if (unchanged && kept) {
    keepJournalLegacyPersonEdits(sourcePath, db, saved)
    return
  }
  const receipt = JSON.stringify(captured)
  const pass: Pass = {
    changed: !unchanged,
    kept,
    lastRead: journalLegacySourceLastRead(saved),
    baselines: [],
    recordEdits: []
  }
  const source = openJournalLegacySource(sourcePath)
  let complete = false
  try {
    complete = absorbChats(source, db, pass)
  } finally {
    source.close()
    // Applied as soon as read, as each chat's own write was: a later pass compares with them.
    complete = applyOlderOrcaRecordEdits(db, pass.recordEdits) && complete
  }
  // Baselines read while another process wrote the original are not current; read them next launch.
  // An original without a certifiable identity can't be rechecked, so its baselines stand.
  if (
    captured.disposition === 'copied-source' &&
    !sameJournalLegacySource(receipt, captureJournalLegacySourceReceipt(sourcePath))
  ) {
    return
  }
  runJournalTransaction(db, () => {
    for (const [id, revision] of pass.baselines) {
      recordJournalLegacyChatRevision(db, id, revision)
    }
    // A failed chat leaves the original unabsorbed, so the next launch retries it.
    if (complete) {
      writeJournalStoreMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT, receipt)
      writeJournalStoreMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT, '1')
      writeJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT, '1')
    }
  })
}

/** What one pass knows about the original, and the chats it takes as already shown here. */
type Pass = {
  changed: boolean
  /** Every chat in the original at the copy was given a revision here. */
  kept: boolean
  /** When the original was last read, in ms; null when no receipt says. */
  lastRead: number | null
  baselines: [string, string][]
  recordEdits: (() => void)[]
}

type Claim = SqliteRow

/** The original's tabs and claims, and this file's tabs, read once per pass. */
type Adoption = {
  savedTabs: Map<string, string>
  claims: Map<string, Claim[]>
  tabbed: Set<string>
  takenTabs: Set<string>
  nextPosition: number
  tabsRecorded: boolean
}

/** True when every chat was absorbed; a failed chat is logged and retried next launch. */
function absorbChats(source: Database.Database, db: Database.Database, pass: Pass): boolean {
  let adoption = readAdoption(source, db)
  runJournalTransaction(db, () => {
    for (const [sessionId, claims] of adoption.claims) {
      insertClaims(db, sessionId, claims)
    }
  })
  let complete = true
  for (const { session_id: id } of source
    .prepare('SELECT session_id FROM agent_session_records ORDER BY rowid')
    .all()) {
    try {
      absorbChat(source, db, String(id), adoption, pass)
    } catch (error) {
      complete = false
      // The failed chat's transaction rolled back; reread what this file now holds.
      adoption = readAdoption(source, db)
      console.warn('[agent-session-journal] keeping an older Orca chat failed', error)
    }
  }
  return complete
}

function readAdoption(source: Database.Database, db: Database.Database): Adoption {
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

function absorbChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  adoption: Adoption,
  pass: Pass
): void {
  // A chat with no history still has a value, so one deleted here stays deleted.
  const revision = journalLegacyChatRevision(source, id) ?? 'null'
  const shown = readJournalStoreMeta(db, journalLegacyChatRevisionKey(id))
  const baseline = (): void => {
    pass.baselines.push([id, revision])
    takeOlderOrcaRecordEdits(source, db, id, pass.recordEdits)
  }
  if (revision === shown) {
    takeOlderOrcaRecordEdits(source, db, id, pass.recordEdits)
    return
  }
  const here =
    db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?').get(id) !== undefined
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  const converted = chat?.epoch !== null && chat?.epoch !== undefined
  // A file copied before revisions were kept has none to compare. An original as copied wrote
  // nothing since; otherwise a chat held here but not converted converts from the current
  // original, so nothing is hidden. The copy cataloged every chat with history, so one it didn't
  // is new, unless it has none: then it may have been deleted here.
  if (
    shown === undefined &&
    (!pass.changed ||
      (!converted && (chat !== undefined ? here : !pass.kept && revision === 'null')))
  ) {
    baseline()
    return
  }
  // A chat this file never saw: the older Orca started it.
  if (shown === undefined && chat === undefined && !here) {
    runJournalTransaction(db, () => {
      adoptChat(source, db, id, id, adoption)
      recordJournalLegacyChatRevision(db, id, revision)
    })
    return
  }
  // With nothing to compare against, its messages are kept rather than taken as shown.
  const cursor = olderMessageCursor(shown, converted ? String(chat.epoch) : null, pass.lastRead)
  const restore = chatHistoryRestore(source, id, cursor)
  if (cursor !== null && !olderOrcaAddedMessages(source, db, id, cursor, revision, restore)) {
    baseline()
    return
  }
  if (converted) {
    keepContinuedChat(source, db, id, revision, adoption, pass, restore())
    return
  }
  // Not converted here yet: its conversion reads the current original, so it joins as itself, with
  // the record of the build that added its newest message.
  runJournalTransaction(db, () => {
    adoptChat(source, db, id, id, adoption)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/** The original's record, a tab and a catalog row, returning the record read; history converts lazily. */
function adoptChat(
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

/**
 * The original's version of a converted chat the older Orca added messages to becomes a second
 * chat beside it, read page by page so no history is held in memory at once.
 */
function keepContinuedChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  adoption: Adoption,
  pass: Pass,
  imported: RestoredJournalDomainImport | null
): void {
  if (!imported) {
    pass.baselines.push([id, revision])
    takeOlderOrcaRecordEdits(source, db, id, pass.recordEdits)
    return
  }
  const { pages, ...header } = imported
  // Derived from the revision, so an interrupted import resumes into the same chat.
  const copy = createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
  const target = { sessionId: copy, epoch: header.epoch }
  for (const page of pages()) {
    runJournalTransaction(db, () => insertJournalDomainImportPage(db, target, page))
  }
  runJournalTransaction(db, () => {
    finishJournalDomainImport(db, { ...header, sessionId: copy, sourceRevision: null })
    passOlderOrcaRecordEditsToCopy(db, id, adoptChat(source, db, id, copy, adoption))
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
function insertClaims(db: Database.Database, sessionId: string, claims: readonly Claim[]): void {
  const insert = db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}
