import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../../sqlite/sync-database'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { agentSessionAttachmentStoreRoot } from '../../agent-session-attachments/agent-session-attachment-references'
import { journalForkAttachmentHeld } from '../journal-fork-stage-state'
import { journalPragmaNumber } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey,
  openJournalLegacySourceChecked
} from './journal-legacy-source'
import { readMeta } from './journal-legacy-reconcile-marks'
import {
  sameJournalLegacySource,
  type JournalLegacySourceReceipt
} from './journal-legacy-source-receipt'
import { captureJournalLegacySourceReceipt } from './journal-legacy-source-capture'

/**
 * What this writer's open learned about uploads an older Orca's journal may hold. Only `absent`
 * and `reconciled` let a sweep remove anything, and `reconciled` still proves its claims each pass.
 */
export type JournalLegacyCustodyStart =
  | { kind: 'unknown' }
  | { kind: 'absent' }
  | { kind: 'reconciled'; receipt: string }

export const JOURNAL_LEGACY_CUSTODY_UNKNOWN: JournalLegacyCustodyStart = { kind: 'unknown' }

/** A missing original with a companion left behind may still hold an older Orca's writes. */
export function journalLegacySourceAbsent(sourcePath: string): boolean {
  return ['', '-wal', '-journal'].every((suffix) => definitivelyAbsent(`${sourcePath}${suffix}`))
}

/** The custody an open may claim for the original as captured before it was read. */
export function journalLegacyCustodyFrom(
  sourcePath: string,
  captured: JournalLegacySourceReceipt
): JournalLegacyCustodyStart {
  if (captured.disposition === 'copied-source') {
    return { kind: 'reconciled', receipt: JSON.stringify(captured) }
  }
  return captured.disposition === 'no-source-at-initialization' &&
    journalLegacySourceAbsent(sourcePath)
    ? { kind: 'absent' }
    : JOURNAL_LEGACY_CUSTODY_UNKNOWN
}

/**
 * Asked once per sweep pass, before it removes anything. The original must still be exactly what
 * this open reconciled, and every upload it claims must be claimed here, gone, or held only by a
 * chat neither journal shows. A saved receipt from an earlier launch never stands in for this read.
 */
export function journalLegacyCustodyKnown(
  stateDirectory: string,
  db: Database.Database,
  start: JournalLegacyCustodyStart
): boolean {
  try {
    const sourcePath = journalDatabasePath(stateDirectory)
    if (start.kind === 'absent') {
      return journalLegacySourceAbsent(sourcePath)
    }
    if (start.kind !== 'reconciled') {
      return false
    }
    const unchanged = () =>
      sameJournalLegacySource(start.receipt, captureJournalLegacySourceReceipt(sourcePath)) &&
      definitivelyAbsent(`${sourcePath}-journal`)
    if (!unchanged()) {
      return false
    }
    const { source } = openJournalLegacySourceChecked(sourcePath)
    let kept: boolean
    try {
      kept = journalLegacyClaimsKept(source, db, agentSessionAttachmentStoreRoot(stateDirectory))
    } finally {
      source.close()
    }
    return kept && unchanged()
  } catch {
    return false
  }
}

function journalLegacyClaimsKept(
  source: Database.Database,
  db: Database.Database,
  root: string
): boolean {
  // Physical tables only: the reader's TEMP stand-in for a dropped table reads as empty.
  const tables = new Set(
    source
      .prepare("SELECT name FROM main.sqlite_schema WHERE type='table'")
      .all()
      .map((row) => String(row.name))
  )
  if (!tables.has('agent_session_attachment_claims')) {
    // v3 (through v1.4.219) predates upload claims; a later file without the table may have lost it.
    return (
      journalPragmaNumber(source, 'user_version') === 3 &&
      tables.has('journal_sessions') &&
      tables.has('journal_rows')
    )
  }
  const claimedHere = db.prepare('SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=?')
  const recordedHere = db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
  const recordedThere = tables.has('agent_session_records')
    ? source.prepare('SELECT 1 FROM main.agent_session_records WHERE session_id=?')
    : undefined
  const resolved = new Map<string, boolean>()
  const chatResolved = (sessionId: string): boolean => {
    if (recordedHere.get(sessionId) !== undefined || journalForkAttachmentHeld(db, sessionId)) {
      return false
    }
    if (recordedThere && recordedThere.get(sessionId) === undefined) {
      return true
    }
    // Deleted here, and the older Orca has not written the chat since.
    const shown = readMeta(db, journalLegacyChatRevisionKey(sessionId))
    return shown !== undefined && shown === (journalLegacyChatRevision(source, sessionId) ?? 'null')
  }
  for (const claim of source
    .prepare('SELECT upload_id, session_id FROM main.agent_session_attachment_claims')
    .all()) {
    const uploadId = String(claim.upload_id)
    if (claimedHere.get(uploadId) !== undefined || !sweepable(root, uploadId)) {
      continue
    }
    const sessionId = String(claim.session_id)
    let done = resolved.get(sessionId)
    if (done === undefined) {
      done = chatResolved(sessionId)
      resolved.set(sessionId, done)
    }
    if (!done) {
      return false
    }
  }
  return true
}

/** Only a present folder named by the id can be swept; an unreadable one counts as present. */
function sweepable(root: string, uploadId: string): boolean {
  if (uploadId === '' || uploadId === '.' || uploadId === '..' || /[\\/]/.test(uploadId)) {
    return false
  }
  return !definitivelyAbsent(join(root, uploadId))
}

function definitivelyAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return isDefinitiveAbsence(error)
  }
}
