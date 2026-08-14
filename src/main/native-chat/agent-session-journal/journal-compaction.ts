// Retention and compaction.
//
// The snapshot carries the retained tail with it, so publishing both is ONE
// atomic write and there is no window where the folded state exists without the
// rows a reconnecting client still needs. Truncating the log afterwards is
// idempotent: a crash before it leaves the log a superset of the tail.
//
// The retained tail must cover the longest reconnect window Orca supports, or a
// client that was merely asleep gets a full snapshot reload instead of a resume.

import {
  referencedBlobDigests,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import { pruneJournalBlobs } from './journal-blob-store'
import {
  rewriteJournalLog,
  writeJournalSnapshotFile,
  type JournalSnapshotFile
} from './journal-log-file'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'

export type JournalCompactionPolicy = {
  /** Always keep at least this many rows, however old they are. */
  minTailRows: number
  /** Keep every row observed within this window. */
  retainTailMs: number
}

/** Two hours of tail comfortably covers a phone that slept through a commute,
 *  which is the longest reconnect Orca resumes rather than reloads. */
export const DEFAULT_JOURNAL_COMPACTION_POLICY: JournalCompactionPolicy = {
  minTailRows: 512,
  retainTailMs: 2 * 60 * 60 * 1000
}

export type JournalCompactionResult = {
  tailRows: JournalRow[]
  compactedThrough: number
  oldestSequence: number
}

export async function compactJournal(input: {
  journalDir: string
  state: JournalReducerState
  tailRows: readonly JournalRow[]
  policy?: JournalCompactionPolicy
  now: number
}): Promise<JournalCompactionResult> {
  const policy = input.policy ?? DEFAULT_JOURNAL_COMPACTION_POLICY
  const retained = retainTail(input.tailRows, policy, input.now)
  const rendered = renderJournalState(input.state)
  const compactedThrough = input.state.lastSequence

  const snapshot: JournalSnapshotFile = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.state.epoch,
    compactedThrough,
    items: rendered.items,
    submissions: rendered.submissions,
    receipts: [...input.state.receipts.values()].map((receipt) => ({
      clientMessageId: receipt.clientMessageId,
      providerItemId: receipt.providerItemId,
      epoch: receipt.cursor.epoch,
      sequence: receipt.cursor.sequence,
      acceptedAt: receipt.acceptedAt
    })),
    aliases: [...input.state.aliases.entries()].map(([providerItemId, itemId]) => ({
      providerItemId,
      itemId
    })),
    tail: retained
  }

  await writeJournalSnapshotFile(input.journalDir, snapshot)
  await rewriteJournalLog(input.journalDir, retained)
  // Blobs are pruned last: a crash before this leaks bytes, whereas pruning
  // first would strand a snapshot pointing at a payload that no longer exists.
  await pruneJournalBlobs(input.journalDir, referencedBlobDigests(input.state))

  return {
    tailRows: retained,
    compactedThrough,
    oldestSequence: retained[0]?.seq ?? compactedThrough + 1
  }
}

function retainTail(
  rows: readonly JournalRow[],
  policy: JournalCompactionPolicy,
  now: number
): JournalRow[] {
  if (rows.length <= policy.minTailRows) {
    return [...rows]
  }
  const floor = now - policy.retainTailMs
  const byAge = rows.findIndex((row) => row.ts >= floor)
  const byCount = rows.length - policy.minTailRows
  const start = byAge === -1 ? byCount : Math.min(byAge, byCount)
  return rows.slice(start)
}
