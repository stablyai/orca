import { createHash } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import type { RestoredJournalDomainImport } from '../journal-domain-import'
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
import { readJournalStoreMeta, writeJournalStoreMeta } from './journal-store-meta'
import {
  captureJournalLegacySourceReceipt,
  JOURNAL_LEGACY_SOURCE_RECEIPT,
  journalLegacySourceLastRead,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'
import {
  adoptChat,
  insertClaims,
  readAdoption,
  type Adoption
} from './journal-legacy-chat-adoption'
import { olderMessageCursor, olderOrcaAddedMessages } from './journal-legacy-older-messages'
import { chatHistoryRestore } from './journal-legacy-message-compare'
import {
  applyOlderOrcaRecordEdits,
  takeOlderOrcaRecordEdits,
  JOURNAL_LEGACY_PERSON_EDITS_KEPT,
  journalLegacyPersonEditsBaseline,
  keepJournalLegacyPersonEdits,
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
    kept,
    lastRead: journalLegacySourceLastRead(saved),
    baselines: [],
    recordEdits: []
  }
  const source = openJournalLegacySource(sourcePath)
  let complete = true
  let personEdits: (() => void) | null = null
  try {
    if (unchanged) {
      // The original wrote nothing since the copy, so each chat is as shown here.
      pass.baselines = missingBaselines(source, db)
      personEdits = journalLegacyPersonEditsBaseline(source, db)
    } else {
      complete = absorbChats(source, db, pass)
    }
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
      if (personEdits) {
        personEdits()
      } else {
        writeJournalStoreMeta(db, JOURNAL_LEGACY_PERSON_EDITS_KEPT, '1')
      }
    }
  })
}

/** What one pass knows about the original, and the chats it takes as already shown here. */
type Pass = {
  /** Every chat in the original at the copy was given a revision here. */
  kept: boolean
  /** When the original was last read, in ms; null when no receipt says. */
  lastRead: number | null
  baselines: [string, string][]
  recordEdits: (() => void)[]
}

/**
 * A baseline is the original's revision when it was read. A write changes the original's identity
 * for good, so while it still matches the saved receipt, no write followed any baseline here.
 */
function missingBaselines(source: Database.Database, db: Database.Database): [string, string][] {
  return originalChatIds(source, 'any')
    .filter((id) => readJournalStoreMeta(db, journalLegacyChatRevisionKey(id)) === undefined)
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
  // A file copied before revisions were kept has none to compare. A chat held here but not
  // converted converts from the current original, so nothing is hidden. The copy cataloged every
  // chat with history, so one it didn't is new, unless it has none: then it may have been deleted
  // here.
  if (
    shown === undefined &&
    !converted &&
    (chat !== undefined ? here : !pass.kept && revision === 'null')
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
