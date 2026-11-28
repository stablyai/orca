import type Database from '../../../sqlite/sync-database'
import { runJournalTransaction } from './journal-database'
import { isSqliteCorruption, isSqliteStorageFailure } from '../../../sqlite/sqlite-read-failure'
import {
  readAdoption,
  adoptJournalLegacyChat,
  journalLegacyOriginalChatIds,
  retainEnumeratedClaims,
  missingBaselines,
  type Adoption
} from './journal-legacy-adoption'
import {
  missingJournalLegacyClaims,
  insertJournalLegacyClaims,
  recoverJournalLegacyClaims,
  journalLegacyClaimsFingerprint,
  clearJournalLegacyClaimFailure
} from './journal-legacy-claims'
import { journalDatabasePath } from './journal-host-database'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey,
  readJournalLegacyFailure,
  journalLegacyFailureKey,
  recordJournalLegacyChatRevision,
  settleJournalLegacyCopy
} from './journal-legacy-source'
import {
  keepContinuedChat,
  keepForcedCopy,
  type JournalLegacyForcedCopy
} from './journal-legacy-copies'
import {
  JOURNAL_LEGACY_COMPARE,
  JOURNAL_LEGACY_COPY_DUE,
  metaKeys,
  readMeta,
  recordJournalLegacyFailure,
  strandedCopies,
  holdsPendingCopy,
  deleteMeta,
  revisionHoldsHistory,
  failuresWithoutOriginal,
  clearUnreadRevisionFailure,
  writeMeta,
  type JournalLegacyFailure
} from './journal-legacy-reconcile-marks'
import {
  JOURNAL_LEGACY_SOURCE_RECEIPT,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'
import {
  JOURNAL_LEGACY_SOURCE_DAMAGED,
  openReconcilableJournalLegacySource
} from './journal-legacy-source-damage'
import { captureJournalLegacySourceReceipt } from './journal-legacy-source-capture'

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
  const forced = new Map<string, JournalLegacyForcedCopy>(
    metaKeys(db, JOURNAL_LEGACY_COPY_DUE).map((id) => [id, {}])
  )
  for (const [id, copy] of strandedCopies(db)) {
    forced.set(id, { stranded: copy })
  }
  if (unchanged && kept && forced.size === 0) {
    return
  }
  const source = openReconcilableJournalLegacySource(db, sourcePath, captured)
  if (!source) {
    return
  }
  const receipt = JSON.stringify(captured)
  const pass: Pass = { kept, forced, baselines: [], compares: [] }
  let complete = true
  let settled: { gone: string[]; clearedClaims: string[] } = { gone: [], clearedClaims: [] }
  try {
    if (unchanged) {
      // The original wrote nothing since the copy, so each chat is as shown here; once every
      // chat carries its revision, only chats due a copy have work.
      if (!kept) {
        pass.baselines = missingBaselines(source, db).filter(([id]) => !forced.has(id))
      }
      complete = forced.size === 0 || absorbChats(source, db, pass, false)
    } else {
      complete = absorbChats(source, db, pass, true)
    }
    if (!unchanged) {
      settled = failuresWithoutOriginal(source, db, pass.claimOwners)
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
    for (const id of settled.gone) {
      deleteMeta(db, journalLegacyFailureKey(id))
    }
    for (const id of settled.clearedClaims) {
      clearJournalLegacyClaimFailure(db, id)
    }
    for (const [id, revision] of pass.baselines) {
      recordJournalLegacyChatRevision(db, id, revision)
    }
    for (const [id, revision] of pass.compares) {
      writeMeta(db, `${JOURNAL_LEGACY_COMPARE}${id}`, revision)
    }
    // A storage failure leaves the original unabsorbed; the next launch retries it.
    if (complete) {
      writeMeta(db, JOURNAL_LEGACY_SOURCE_RECEIPT, receipt)
      writeMeta(db, JOURNAL_LEGACY_REVISIONS_KEPT, '1')
      deleteMeta(db, JOURNAL_LEGACY_SOURCE_DAMAGED)
    }
  })
}

/** What one pass knows about the original, and the chats it takes as already shown here. */
type Pass = {
  /** Every chat in the original at the copy was given a revision here. */
  kept: boolean
  /** Chats that get a copy whatever their revision shows. */
  forced: ReadonlyMap<string, JournalLegacyForcedCopy>
  baselines: [string, string][]
  /** Converted chats with no revision to compare, for the background compare. */
  compares: [string, string][]
  claimOwners?: Pick<Adoption['claims'], 'has'>
}

/**
 * False only when a storage failure stopped the pass. A chat that fails otherwise is recorded with its
 * error and taken as absorbed, so one bad chat can't rerun the pass at every launch. Without a walk,
 * only chats due a copy are visited.
 */
function absorbChats(
  source: Database.Database,
  db: Database.Database,
  pass: Pass,
  walk: boolean
): boolean {
  const adoption = readAdoption(source, db, walk ? null : [...pass.forced.keys()])
  pass.claimOwners = adoption.claims
  let chats: string[]
  try {
    chats = walk ? journalLegacyOriginalChatIds(source, 'saved') : [...pass.forced.keys()]
  } catch (error) {
    retainEnumeratedClaims(db, adoption)
    throw error
  }
  const claimOnlyChats = new Set(adoption.claims.keys())
  if (claimOnlyChats.size > 0) {
    for (const id of chats) {
      claimOnlyChats.delete(id)
    }
    for (const id of claimOnlyChats) {
      chats.push(id)
    }
  }
  for (const id of chats) {
    let revision: string | undefined
    const added = adoption.added.length
    const { nextPosition, tabsRecorded } = adoption
    const attempt = { claimsOnly: claimOnlyChats.has(id), adopting: false }
    try {
      // A chat with no history still has a value, so one deleted here stays deleted.
      if (!attempt.claimsOnly) {
        revision = journalLegacyChatRevision(source, id) ?? 'null'
      }
      absorbChat(source, db, id, revision ?? 'null', adoption, pass, attempt)
    } catch (error) {
      // Corruption past the original's own revision read may be this file's: never absorb it. A
      // rollback that failed leaves this connection mid-transaction for every later chat.
      if (
        isSqliteStorageFailure(error) ||
        (revision !== undefined && isSqliteCorruption(error)) ||
        db.isTransaction
      ) {
        retainEnumeratedClaims(db, adoption)
        console.warn('[agent-session-journal] keeping chats an older Orca saved paused', error)
        return false
      }
      const failure: JournalLegacyFailure = {
        sessionId: id,
        revision: attempt.claimsOnly ? undefined : revision,
        error,
        ...(attempt.adopting ? { adoption: true } : {})
      }
      try {
        recoverJournalLegacyClaims(db, id, adoption.claims.get(id) ?? [], (claims) => {
          failure.claims = claims
          if (attempt.claimsOnly && claims === null) {
            clearJournalLegacyClaimFailure(db, id)
          } else {
            recordJournalLegacyFailure(db, failure)
          }
          const { stranded } = pass.forced.get(id) ?? {}
          if (stranded !== undefined && claims !== 'pending') {
            settleJournalLegacyCopy(db, stranded)
          }
        })
      } catch (failureError) {
        retainEnumeratedClaims(db, adoption)
        console.warn(
          '[agent-session-journal] keeping chats an older Orca saved paused',
          failureError
        )
        return false
      }
      console.warn('[agent-session-journal] keeping an older Orca chat failed', error)
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

function absorbChat(
  source: Database.Database,
  db: Database.Database,
  id: string,
  revision: string,
  adoption: Adoption,
  pass: Pass,
  attempt: { claimsOnly: boolean; adopting: boolean }
): void {
  const claims = missingJournalLegacyClaims(db, id, adoption.claims.get(id) ?? [])
  const failure = readJournalLegacyFailure(db, id)
  let fingerprint: string | undefined
  const sameRefusal = () =>
    failure?.claims !== undefined &&
    failure.claims === (fingerprint ??= journalLegacyClaimsFingerprint(claims))
  const write = (keep: () => void) =>
    runJournalTransaction(db, () => {
      insertJournalLegacyClaims(db, id, claims)
      clearJournalLegacyClaimFailure(db, id)
      keep()
    })
  const claimsOnly = () => {
    attempt.claimsOnly = true
    if (claims.length > 0) {
      if (!sameRefusal()) {
        write(() => {})
      }
    } else if (failure?.claims) {
      runJournalTransaction(db, () => clearJournalLegacyClaimFailure(db, id))
    }
  }
  const adopt = (copy: string) => adoptJournalLegacyChat(source, db, id, copy, adoption)
  if (attempt.claimsOnly) {
    claimsOnly()
    return
  }
  const forced = pass.forced.get(id)
  if (forced) {
    attempt.adopting = true
    write(() => keepForcedCopy(db, id, revision, forced, adopt))
    return
  }
  const shown = readMeta(db, journalLegacyChatRevisionKey(id))
  if (revision === shown) {
    if (sameRefusal()) {
      return
    }
    // A refused adoption retries when its refused claims change; history-only failures stay held.
    if (!failure?.claims || !failure.adoption) {
      clearUnreadRevisionFailure(db, id, failure)
      claimsOnly()
      return
    }
  }
  const chat = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(id)
  const converted = chat?.epoch !== null && chat?.epoch !== undefined
  // A file copied before revisions were kept cataloged every chat with history; an unconverted
  // chat still reads the current original, while a deleted empty chat stays deleted.
  if (
    shown === undefined &&
    !converted &&
    (chat !== undefined || (!pass.kept && revision === 'null'))
  ) {
    pass.baselines.push([id, revision])
    claimsOnly()
    return
  }
  if (converted) {
    if (shown === undefined && revisionHoldsHistory(revision)) {
      pass.compares.push([id, revision])
      claimsOnly()
      return
    }
    if (holdsPendingCopy(db, id)) {
      pass.baselines.push([id, revision])
      claimsOnly()
      return
    }
    attempt.adopting = true
    write(() => keepContinuedChat(db, id, revision, adopt))
    return
  }
  // Not converted here yet: its conversion reads the current original, so it joins as itself.
  attempt.adopting = true
  write(() => {
    adoptJournalLegacyChat(source, db, id, id, adoption)
    recordJournalLegacyChatRevision(db, id, revision)
  })
}
