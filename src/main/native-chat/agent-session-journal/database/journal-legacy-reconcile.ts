import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type Database from '../../../sqlite/sync-database'
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
  JOURNAL_LEGACY_SOURCE_RECEIPT
} from './journal-legacy-source-receipt'

/**
 * An older Orca keeps writing the original journal after a downgrade. Every launch compares each
 * original chat's revision with the one this file already shows: a chat it started or continued
 * before conversion joins as itself, and a converted chat it continued is kept as a second chat
 * beside it, so no turn it saved goes missing. Nothing here deletes a chat or its turns.
 */
export function reconcileJournalLegacySource(stateDirectory: string, db: Database.Database): void {
  const sourcePath = journalDatabasePath(stateDirectory)
  if (!existsSync(sourcePath)) {
    return
  }
  // Captured before reading, so a write during this pass is never taken as absorbed.
  const receipt = JSON.stringify(captureJournalLegacySourceReceipt(sourcePath))
  const absorbed = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get(JOURNAL_LEGACY_SOURCE_RECEIPT)?.value
  const source = openJournalLegacySource(sourcePath)
  try {
    const ids = source
      .prepare('SELECT session_id FROM agent_session_records ORDER BY rowid')
      .all()
      .map((row) => String(row.session_id))
    if (absorbed === receipt) {
      // Unchanged since the last pass: chats converted before revisions were kept are current.
      runJournalTransaction(db, () => {
        for (const id of ids) {
          const revision = journalLegacyChatRevision(source, id)
          if (revision !== null && keptRevision(db, id) === undefined) {
            recordJournalLegacyChatRevision(db, id, revision)
          }
        }
      })
    }
    runJournalTransaction(db, () => copyAttachmentClaims(source, db))
    for (const id of ids) {
      try {
        absorbChat(source, db, id)
      } catch (error) {
        console.warn('[agent-session-journal] keeping an older Orca chat failed', error)
      }
    }
  } finally {
    source.close()
  }
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    JOURNAL_LEGACY_SOURCE_RECEIPT,
    receipt
  )
}

function keptRevision(db: Database.Database, id: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    .get(journalLegacyChatRevisionKey(id))
  return row === undefined ? undefined : String(row.value)
}

function absorbChat(source: Database.Database, db: Database.Database, id: string): void {
  const revision = journalLegacyChatRevision(source, id)
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  if (revision === null) {
    // A record without history: only a chat this file has never seen is new.
    if (!chat && !db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?').get(id)) {
      runJournalTransaction(db, () => adoptChat(source, db, id, id))
    }
    return
  }
  if (revision === keptRevision(db, id)) {
    return
  }
  if (chat?.epoch !== null && chat?.epoch !== undefined) {
    keepContinuedChat(source, db, id, revision)
    return
  }
  // Not converted here yet: its conversion reads the current original, so it joins as itself.
  runJournalTransaction(db, () => {
    adoptChat(source, db, id, id)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/** The original's record, a tab and a catalog row; history converts lazily as usual. */
function adoptChat(source: Database.Database, db: Database.Database, id: string, as: string): void {
  const record = String(
    source.prepare('SELECT record_json FROM agent_session_records WHERE session_id=?').get(id)!
      .record_json
  )
  // A copy takes its own id and leaves the original's /clear successor to the original.
  db.prepare(`INSERT INTO agent_session_records(session_id,record_json) VALUES(?1,
    CASE WHEN ?1=?3 THEN ?2 ELSE json_remove(json_set(?2,'$.sessionId',?1,'$.lease.sessionId',?1),
      '$.conversationCommand') END)
    ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json`).run(as, record, id)
  const saved =
    as === id
      ? source.prepare('SELECT tab_id FROM agent_session_tabs WHERE session_id=?').get(id)?.tab_id
      : undefined
  const tab =
    saved !== undefined && !db.prepare('SELECT 1 FROM agent_session_tabs WHERE tab_id=?').get(saved)
      ? String(saved)
      : structuredAgentSessionTabId(as)
  if (!db.prepare('SELECT 1 FROM agent_session_tabs WHERE session_id=?').get(as)) {
    db.prepare(`INSERT INTO agent_session_tabs(tab_id,session_id,position)
      SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM agent_session_tabs`).run(tab, as)
  }
  const session = source
    .prepare('SELECT workspace_id FROM journal_sessions WHERE session_id=?')
    .get(id)
  if (as === id && session) {
    db.prepare(
      'INSERT INTO journal_chat_state(session_id,workspace_id) VALUES(?,?) ON CONFLICT DO NOTHING'
    ).run(id, session.workspace_id)
  }
  db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,claimed_at)
    SELECT upload_id,?,claimed_at FROM agent_session_attachment_claims WHERE session_id=?
    ON CONFLICT DO NOTHING`).run(as, id)
}

/** The original's version of a converted chat it moved past becomes a second chat beside it. */
function keepContinuedChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string
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
    adoptChat(source, db, id, copy)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}

/** Uploads the older Orca attached stay claimed, so the sweeper never removes them. */
function copyAttachmentClaims(source: Database.Database, db: Database.Database): void {
  const insert =
    db.prepare(`INSERT INTO agent_session_attachment_claims(upload_id,session_id,claimed_at)
    VALUES(?,?,?) ON CONFLICT DO NOTHING`)
  for (const claim of source
    .prepare('SELECT upload_id,session_id,claimed_at FROM agent_session_attachment_claims')
    .all()) {
    insert.run(claim.upload_id, claim.session_id, claim.claimed_at)
  }
}
