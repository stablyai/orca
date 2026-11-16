import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { runJournalTransaction } from './journal-database'
import { isSqliteStorageFailure } from '../../../sqlite/sqlite-read-failure'
import { AGENT_SESSION_TABS_RECORDED } from '../../../runtime/agent-session/records/agent-session-record-rows'
import { journalDatabasePath } from './journal-host-database'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey,
  journalLegacyCopySourceKey,
  openJournalLegacySource,
  recordJournalLegacyChatRevision
} from './journal-legacy-source'
import {
  deleteMeta,
  JOURNAL_LEGACY_COMPARE,
  JOURNAL_LEGACY_COPY_DUE,
  awaitsConversion,
  continuedCopyId,
  metaKeys,
  readMeta,
  recordJournalLegacyFailure,
  revisionHoldsHistory,
  writeMeta,
  type JournalLegacyFailure
} from './journal-legacy-reconcile-marks'
import {
  captureJournalLegacySourceReceipt,
  JOURNAL_LEGACY_SOURCE_RECEIPT,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'

/** Set after a pass absorbed every original chat, so each chat here carries its revision. */
export const JOURNAL_LEGACY_REVISIONS_KEPT = 'journal.legacy-revisions-kept.v1'
/**
 * An older Orca keeps writing the original journal after a downgrade. When the original changed,
 * each original chat's revision is compared with the one this file shows: a chat it started, or
 * one not converted here yet, joins as itself; a converted chat it continued is kept as a second
 * chat beside it, so no turn it saved goes missing. Nothing here deletes a chat or its turns.
 * Terminal restore waits for this pass, so it reads no history: a copy's history converts later
 * like any unconverted chat's, and a chat needing a history compare is compared in the background.
 */
export function reconcileJournalLegacySource(stateDirectory: string, db: Database.Database): void {
  const sourcePath = journalDatabasePath(stateDirectory)
  // Captured before reading, so a write during this pass is never taken as absorbed. Until every
  // chat here carries its revision (files converted before revisions were kept), each launch reads.
  const captured = captureJournalLegacySourceReceipt(sourcePath)
  if (captured.disposition === 'no-source-at-initialization') {
    return
  }
  const saved = readMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT)
  const unchanged = sameJournalLegacySource(saved, captured)
  const kept = readMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT) !== undefined
  const due = metaKeys(db, JOURNAL_LEGACY_COPY_DUE)
  if (unchanged && kept && due.length === 0) {
    return
  }
  const receipt = JSON.stringify(captured)
  const pass: Pass = { changed: !unchanged, kept, due, baselines: [], failures: [] }
  const source = openJournalLegacySource(sourcePath)
  let complete: boolean
  try {
    complete = absorbChats(source, db, pass, !(unchanged && kept))
  } finally {
    source.close()
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
    for (const failure of pass.failures) {
      recordJournalLegacyFailure(db, failure)
    }
    for (const id of pass.due) {
      deleteMeta(db, `${JOURNAL_LEGACY_COPY_DUE}${id}`)
    }
    // A storage failure leaves the original unabsorbed; the next launch retries it.
    if (complete) {
      writeMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT, receipt)
      writeMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT, '1')
    }
  })
}

/** What one pass knows about the original, and the chats it takes as already shown here. */
type Pass = {
  changed: boolean
  /** Every chat in the original at the copy was given a revision here. */
  kept: boolean
  /** Converted chats a background compare found holding turns this file lacks. */
  due: readonly string[]
  baselines: [string, string][]
  failures: JournalLegacyFailure[]
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
  /** Tabs this pass added, so a chat that fails can take back its own. */
  added: [sessionId: string, tab: string][]
}

/**
 * False only when a storage failure stopped the pass. A chat that fails otherwise is recorded with its
 * error and taken as absorbed, so one bad chat can't rerun the pass at every launch.
 */
function absorbChats(
  source: Database.Database,
  db: Database.Database,
  pass: Pass,
  walk: boolean
): boolean {
  const adoption = readAdoption(source, db)
  runJournalTransaction(db, () => {
    for (const [sessionId, claims] of adoption.claims) {
      insertClaims(db, sessionId, claims)
    }
  })
  const chats = walk
    ? source
        .prepare('SELECT session_id FROM agent_session_records ORDER BY rowid')
        .all()
        .map((row) => String(row.session_id))
    : pass.due
  for (const id of chats) {
    let revision: string | undefined
    const added = adoption.added.length
    const { nextPosition, tabsRecorded } = adoption
    try {
      // A chat with no history still has a value, so one deleted here stays deleted.
      revision = journalLegacyChatRevision(source, id) ?? 'null'
      absorbChat(source, db, id, revision, adoption, pass)
    } catch (error) {
      if (isSqliteStorageFailure(error)) {
        console.warn('[agent-session-journal] keeping chats an older Orca saved paused', error)
        return false
      }
      pass.failures.push({ sessionId: id, revision, error })
      // The failed chat's transaction rolled back, and with it any tab it added.
      for (const [sessionId, tab] of adoption.added.splice(added)) {
        adoption.tabbed.delete(sessionId)
        adoption.takenTabs.delete(tab)
      }
      Object.assign(adoption, { nextPosition, tabsRecorded })
    }
  }
  return true
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
    tabsRecorded: readMeta(db, AGENT_SESSION_TABS_RECORDED) !== undefined,
    added: []
  }
}

function absorbChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  adoption: Adoption,
  pass: Pass
): void {
  const shown = readMeta(db, journalLegacyChatRevisionKey(id))
  if (revision === shown) {
    return
  }
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  const converted = chat?.epoch !== null && chat?.epoch !== undefined
  if (pass.due.includes(id)) {
    runJournalTransaction(db, () => keepCopy(source, db, id, revision, adoption))
    return
  }
  // A file copied before revisions were kept has none to compare. An original as copied wrote
  // nothing since; otherwise a chat this file cataloged but hasn't converted converts from the
  // current original, so nothing is hidden. The copy cataloged every chat with history, so one it
  // didn't is new, unless it has none: then it may have been deleted here.
  if (
    shown === undefined &&
    (!pass.changed || (!converted && (chat !== undefined || (!pass.kept && revision === 'null'))))
  ) {
    pass.baselines.push([id, revision])
    return
  }
  if (converted) {
    keepContinuedChat(source, db, id, revision, shown, adoption, pass)
    return
  }
  // Not converted here yet: its conversion reads the current original, so it joins as itself.
  runJournalTransaction(db, () => {
    adoptChat(source, db, id, id, adoption)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/** The original's record, a tab and a catalog row; history converts lazily as usual. */
function adoptChat(
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
    insertClaims(db, as, adoption.claims.get(id) ?? [])
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

/**
 * The original's version of a converted chat it moved past becomes a second chat beside it. Only
 * its record is made here; its history converts from the original chat when opened or idle. With
 * no revision to compare (files copied before revisions were kept), a background compare decides.
 */
function keepContinuedChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  shown: string | undefined,
  adoption: Adoption,
  pass: Pass
): void {
  if (shown === undefined && revisionHoldsHistory(revision)) {
    writeMeta(db, `${JOURNAL_LEGACY_COMPARE}${id}`, revision)
    return
  }
  // A copy still waiting to convert reads the current original, so it already holds this write.
  if (shown !== undefined && awaitsConversion(db, id, continuedCopyId(id, shown))) {
    pass.baselines.push([id, revision])
    return
  }
  runJournalTransaction(db, () => keepCopy(source, db, id, revision, adoption))
}

function keepCopy(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  adoption: Adoption
): void {
  if (!revisionHoldsHistory(revision)) {
    recordJournalLegacyChatRevision(db, id, revision)
    return
  }
  const copy = continuedCopyId(id, revision)
  adoptChat(source, db, id, copy, adoption)
  writeMeta(db, journalLegacyCopySourceKey(copy), id)
  recordJournalLegacyChatRevision(db, id, revision)
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
function insertClaims(db: Database.Database, sessionId: string, claims: readonly Claim[]): void {
  const insert = db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}
