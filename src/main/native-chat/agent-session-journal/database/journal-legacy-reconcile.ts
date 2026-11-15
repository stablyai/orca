import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { prepareJournalDomainImport } from '../journal-domain-import'
import {
  finishJournalDomainImport,
  insertJournalDomainImportPage
} from '../journal-domain-import-rows'
import { runJournalTransaction } from './journal-database'
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
  type JournalLegacySourceReceipt
} from './journal-legacy-source-receipt'

/** Set once every converted chat in this file carries the original revision it shows. */
export const JOURNAL_LEGACY_REVISIONS_KEPT = 'journal.legacy-revisions-kept.v1'

/**
 * An older Orca keeps writing the original journal after a downgrade. When the original changed,
 * each original chat's revision is compared with the one this file shows: a chat it started, or
 * one not converted here yet, joins as itself; a converted chat it continued is kept as a second
 * chat beside it, so no turn it saved goes missing. Nothing here deletes a chat or its turns.
 */
export function reconcileJournalLegacySource(stateDirectory: string, db: Database.Database): void {
  const sourcePath = journalDatabasePath(stateDirectory)
  if (!existsSync(sourcePath)) {
    return
  }
  // Captured before reading, so a write during this pass is never taken as absorbed.
  const receipt = captureJournalLegacySourceReceipt(sourcePath)
  const kept = readMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT) !== undefined
  const unchanged =
    receipt.disposition !== 'uncertifiable' &&
    sameSource(readMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT), receipt, kept)
  if (unchanged && kept) {
    return
  }
  const source = openJournalLegacySource(sourcePath)
  try {
    if (unchanged) {
      keepCurrentRevisions(source, db)
    } else if (!absorbChats(source, db)) {
      // A failed chat leaves the original unabsorbed, so the next launch retries it.
      return
    }
  } finally {
    source.close()
  }
  runJournalTransaction(db, () => {
    writeMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT, JSON.stringify(receipt))
    writeMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT, '1')
  })
}

/** Before revisions were kept, a receipt named a nonempty WAL by its size alone. */
function sameSource(
  absorbed: string | undefined,
  receipt: JournalLegacySourceReceipt,
  exact: boolean
): boolean {
  if (exact || receipt.disposition !== 'copied-source' || receipt.wal.kind === 'empty') {
    return absorbed === JSON.stringify(receipt)
  }
  const { kind, size } = receipt.wal
  return absorbed === JSON.stringify({ ...receipt, wal: { kind, size } })
}

/** Unchanged since the last pass: chats converted before revisions were kept show the current one. */
function keepCurrentRevisions(source: Database.Database, db: Database.Database): void {
  runJournalTransaction(db, () => {
    for (const { session_id: id } of db
      .prepare('SELECT session_id FROM journal_chat_state WHERE epoch IS NOT NULL')
      .all()) {
      const revision = journalLegacyChatRevision(source, String(id))
      if (
        revision !== null &&
        readMeta(db, journalLegacyChatRevisionKey(String(id))) === undefined
      ) {
        recordJournalLegacyChatRevision(db, String(id), revision)
      }
    }
  })
}

type Claim = SqliteRow

/** The original's tabs and claims, and this file's tabs, read once per pass. */
type Adoption = {
  savedTabs: Map<string, string>
  claims: Map<string, Claim[]>
  tabbed: Set<string>
  takenTabs: Set<string>
  nextPosition: number
}

/** True when every chat was absorbed; a failed chat is logged and retried next launch. */
function absorbChats(source: Database.Database, db: Database.Database): boolean {
  const adoption = readAdoption(source, db)
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
      absorbChat(source, db, String(id), adoption)
    } catch (error) {
      complete = false
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
    claims.set(id, [...(claims.get(id) ?? []), claim])
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
    nextPosition: Number(tail?.tail ?? -1) + 1
  }
}

function absorbChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  adoption: Adoption
): void {
  // A chat with no history still has a value, so one deleted here stays deleted.
  const revision = journalLegacyChatRevision(source, id) ?? 'null'
  if (revision === readMeta(db, journalLegacyChatRevisionKey(id))) {
    return
  }
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  if (chat?.epoch !== null && chat?.epoch !== undefined) {
    keepContinuedChat(source, db, id, revision, adoption)
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
  if (!adoption.tabbed.has(as)) {
    const saved = as === id ? adoption.savedTabs.get(id) : undefined
    const tab =
      saved !== undefined && !adoption.takenTabs.has(saved)
        ? saved
        : structuredAgentSessionTabId(as)
    db.prepare('INSERT INTO agent_session_tabs(tab_id,session_id,position) VALUES(?,?,?)').run(
      tab,
      as,
      adoption.nextPosition
    )
    adoption.nextPosition += 1
    adoption.tabbed.add(as)
    adoption.takenTabs.add(tab)
  }
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

/** The original's version of a converted chat it moved past becomes a second chat beside it. */
function keepContinuedChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  adoption: Adoption
): void {
  const imported = prepareJournalDomainImport(source, id)
  if (!imported) {
    runJournalTransaction(db, () => recordJournalLegacyChatRevision(db, id, revision))
    return
  }
  // Derived from the revision, so an interrupted import resumes into the same chat.
  const copy = createHash('sha256').update(`${id}\0${revision}`).digest('hex').slice(0, 32)
  const { pages, ...header } = imported
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
