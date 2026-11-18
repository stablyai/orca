import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { prepareJournalDomainImport, type JournalDomainImportPage } from '../journal-domain-import'
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
  if (unchanged && kept) {
    return
  }
  const receipt = JSON.stringify(captured)
  const pass: Pass = { kept, baselines: [] }
  const source = openJournalLegacySource(sourcePath)
  let complete = true
  try {
    if (unchanged) {
      // The original wrote nothing since the copy, so each chat is as shown here.
      pass.baselines = missingBaselines(source, db)
    } else {
      complete = absorbChats(source, db, pass)
    }
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
    // A failed chat leaves the original unabsorbed, so the next launch retries it.
    if (complete) {
      writeMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT, receipt)
      writeMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT, '1')
    }
  })
}

/** What one pass knows about the original, and the chats it takes as already shown here. */
type Pass = {
  /** Every chat in the original at the copy was given a revision here. */
  kept: boolean
  baselines: [string, string][]
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

/**
 * A baseline is the original's revision when it was read. A write changes the original's identity
 * for good, so while it still matches the saved receipt, no write followed any baseline here.
 */
function missingBaselines(source: Database.Database, db: Database.Database): [string, string][] {
  return originalChatIds(source, 'any')
    .filter((id) => readMeta(db, journalLegacyChatRevisionKey(id)) === undefined)
    .map((id): [string, string] => [id, journalLegacyChatRevision(source, id) ?? 'null'])
}

/** Adoption takes chats in the original's saved order; in any order, the id index alone answers. */
function originalChatIds(source: Database.Database, order: 'saved' | 'any'): string[] {
  return source
    .prepare(
      order === 'saved'
        ? 'SELECT session_id FROM agent_session_records ORDER BY rowid'
        : 'SELECT session_id FROM agent_session_records'
    )
    .all()
    .map((row) => String(row.session_id))
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
  for (const id of originalChatIds(source, 'saved')) {
    try {
      absorbChat(source, db, id, adoption, pass)
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
    tabsRecorded: readMeta(db, AGENT_SESSION_TABS_RECORDED) !== undefined
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
  const shown = readMeta(db, journalLegacyChatRevisionKey(id))
  if (revision === shown) {
    return
  }
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  const converted = chat?.epoch !== null && chat?.epoch !== undefined
  // A file copied before revisions were kept has none to compare. A chat this file cataloged but
  // hasn't converted converts from the current original, so nothing is hidden. The copy cataloged
  // every chat with history, so one it didn't is new, unless it has none: then it may have been
  // deleted here.
  if (
    shown === undefined &&
    !converted &&
    (chat !== undefined || (!pass.kept && revision === 'null'))
  ) {
    pass.baselines.push([id, revision])
    return
  }
  if (converted) {
    keepContinuedChat(source, db, id, revision, shown !== undefined, adoption, pass)
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
  if (as === id && session) {
    db.prepare(
      'INSERT INTO journal_chat_state(session_id,workspace_id) VALUES(?,?) ON CONFLICT DO NOTHING'
    ).run(id, session.workspace_id)
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
}

/**
 * The original's version of a converted chat it moved past becomes a second chat beside it. With
 * no revision to compare (files copied before revisions were kept), the original moved past this
 * chat only if its restored history has an item this chat never held.
 */
function keepContinuedChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  compared: boolean,
  adoption: Adoption,
  pass: Pass
): void {
  const imported = prepareJournalDomainImport(source, id)
  if (!imported) {
    pass.baselines.push([id, revision])
    return
  }
  const { pages: read, ...header } = imported
  let pages: Iterable<JournalDomainImportPage> = read
  if (!compared) {
    const all = [...read]
    if (heldEveryItem(db, id, all)) {
      pass.baselines.push([id, revision])
      return
    }
    pages = all
  }
  // Derived from the revision, so an interrupted import resumes into the same chat.
  const copy = createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
  const target = { sessionId: copy, epoch: header.epoch }
  for (const page of pages) {
    runJournalTransaction(db, () => insertJournalDomainImportPage(db, target, page))
  }
  runJournalTransaction(db, () => {
    finishJournalDomainImport(db, { ...header, sessionId: copy, sourceRevision: null })
    adoptChat(source, db, id, copy, adoption)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/**
 * Removing an item here leaves its tombstone, so every item this chat converted stays held, at
 * its converted revision or a later one.
 */
function heldEveryItem(
  db: Database.Database,
  id: string,
  pages: readonly JournalDomainImportPage[]
): boolean {
  const held = new Map(
    db
      .prepare(`SELECT item_id AS id, MAX(revision) AS revision FROM (
          SELECT item_id, revision FROM journal_items WHERE session_id=?1
          UNION ALL SELECT item_id, ?2 FROM journal_item_tombstones WHERE session_id=?1)
        GROUP BY item_id`)
      .all(id, Number.MAX_SAFE_INTEGER)
      .map((row) => [String(row.id), Number(row.revision)])
  )
  return pages.every(
    (page) =>
      page.kind !== 'items' ||
      page.rows.every(({ item }) => (held.get(item.itemId) ?? -1) >= item.revision)
  )
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
function insertClaims(db: Database.Database, sessionId: string, claims: readonly Claim[]): void {
  const insert = db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,
    claimed_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of claims) {
    insert.run(claim.upload_id!, sessionId, claim.claimed_at!)
  }
}

function readMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}

function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    key,
    value
  )
}
