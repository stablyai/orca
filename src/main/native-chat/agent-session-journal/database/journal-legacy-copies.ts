import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import {
  journalLegacyCopySourceKey,
  journalLegacyFailureKey,
  journalLegacyPendingCopyKey,
  recordJournalLegacyChatRevision,
  settleJournalLegacyCopy
} from './journal-legacy-source'
import {
  continuedCopyId,
  deleteMeta,
  holdsPendingCopy,
  JOURNAL_LEGACY_COPY_DUE,
  revisionHoldsHistory,
  writeMeta
} from './journal-legacy-reconcile-marks'

/**
 * A background compare found turns this file lacks, or a copy was `stranded`: readied by another
 * build without the original's history.
 */
export type JournalLegacyForcedCopy = { stranded?: string }

/** Adds the original's record as this id, with its tab, catalog row and claims. */
type Adopt = (as: string) => void

/**
 * The original's version of a converted chat it moved past becomes a second chat beside it. Only
 * its record is made here; its history converts from the original chat when opened or idle. With
 * no revision to compare (files copied before revisions were kept), a background compare decides.
 */
export function keepContinuedChat(
  db: Database.Database,
  id: string,
  revision: string,
  shown: string | undefined,
  adopt: Adopt,
  pass: { baselines: [string, string][]; compares: [string, string][] }
): void {
  if (shown === undefined && revisionHoldsHistory(revision)) {
    pass.compares.push([id, revision])
    return
  }
  if (holdsPendingCopy(db, id)) {
    pass.baselines.push([id, revision])
    return
  }
  runJournalTransaction(db, () => keepCopy(db, id, revision, adopt))
}

/** Background conversion skips a copy whose history failed to convert; opening it still retries. */
export function recordJournalLegacyCopyFailure(
  db: Database.Database,
  copyId: string,
  error: string
): void {
  if (
    db
      .prepare('SELECT 1 FROM agent_session_store_meta WHERE key=?')
      .get(journalLegacyCopySourceKey(copyId))
  ) {
    writeMeta(db, journalLegacyFailureKey(copyId), JSON.stringify({ revision: null, error }))
  }
}

/** In the caller's transaction. */
export function keepForcedCopy(
  db: Database.Database,
  id: string,
  revision: string,
  forced: JournalLegacyForcedCopy,
  adopt: Adopt
): void {
  deleteMeta(db, `${JOURNAL_LEGACY_COPY_DUE}${id}`)
  if (forced.stranded === undefined) {
    keepCopy(db, id, revision, adopt)
    return
  }
  settleJournalLegacyCopy(db, forced.stranded)
  keepCopy(db, id, revision, adopt, continuedCopyId(id, forced.stranded))
}

function keepCopy(
  db: Database.Database,
  id: string,
  revision: string,
  adopt: Adopt,
  copy = continuedCopyId(id, revision)
): void {
  if (!revisionHoldsHistory(revision)) {
    recordJournalLegacyChatRevision(db, id, revision)
    return
  }
  adopt(copy)
  writeMeta(db, journalLegacyCopySourceKey(copy), id)
  writeMeta(db, journalLegacyPendingCopyKey(id), copy)
  recordJournalLegacyChatRevision(db, id, revision)
}
