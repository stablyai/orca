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
  blobDigestsInBody,
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
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalCompactionPolicy = {
  /** Always keep at least this many rows, however old they are. */
  minTailRows: number
  /** Keep every row observed within this window. */
  retainTailMs: number
  /**
   * `window` honours `retainTailMs` outright. `budget-pressure` lets it yield:
   * the alternative is refusing the user's writes until the window ages out,
   * and the tail is only a resume optimization — compaction folds every shed
   * row into the snapshot before truncating the log, so a client that loses
   * its resume point reloads instead of losing conversation. Defaults to
   * `window`.
   */
  retention?: 'window' | 'budget-pressure'
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
  maxSessionBytes: number
}): Promise<JournalCompactionResult> {
  const policy = input.policy ?? DEFAULT_JOURNAL_COMPACTION_POLICY
  const retained = retainTail(input.tailRows, policy, input.now)
  const rendered = renderJournalState(input.state)
  const compactedThrough = input.state.lastSequence

  const snapshot: JournalSnapshotFile = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.state.epoch,
    compactedThrough,
    highestFence: input.state.highestFence,
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
    tombstones: [...input.state.tombstones.entries()].map(([itemId, revision]) => ({
      itemId,
      revision
    })),
    tail: retained
  }

  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  if (snapshotBytes > input.maxSessionBytes) {
    throw new AgentSessionJournalError(
      'journal_bound_exceeded',
      `agent-session journal snapshot reached its ${input.maxSessionBytes}-byte bound`
    )
  }

  await writeJournalSnapshotFile(input.journalDir, snapshot)
  await rewriteJournalLog(input.journalDir, retained)
  // Blobs are pruned last: a crash before this leaks bytes, whereas pruning
  // first would strand a snapshot pointing at a payload that no longer exists.
  const retainedDigests = referencedBlobDigests(input.state)
  for (const row of retained) {
    if (row.kind === 'item') {
      blobDigestsInBody(row.body, retainedDigests)
    }
  }
  await pruneJournalBlobs(input.journalDir, retainedDigests)

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
  if (policy.retention !== 'budget-pressure') {
    return rows.slice(start)
  }
  // Halve rather than empty: the newer half keeps live clients resuming, and
  // shedding at least one row guarantees the append that triggered this makes
  // progress instead of latching the session read-only.
  return rows.slice(Math.max(start, Math.ceil(rows.length / 2)))
}

/** Only when the retention window would actually drop rows: inside it,
 *  compaction rewrites an identical log, and doing that per append is a full
 *  state serialization on the hot path. */
export function journalTailIsReadyToCompact(
  tailRows: readonly JournalRow[],
  policy: JournalCompactionPolicy,
  now: number
): boolean {
  if (tailRows.length <= policy.minTailRows * 2) {
    return false
  }
  return (tailRows[0]?.ts ?? now) < now - policy.retainTailMs
}

/** The policy an append falls back to when the size bound would otherwise
 *  refuse it: both floors that normally protect the tail step aside. */
export function budgetPressurePolicy(policy: JournalCompactionPolicy): JournalCompactionPolicy {
  return { ...policy, minTailRows: 0, retention: 'budget-pressure' }
}

/** Budget pressure may need to shed rows before the ordinary batching threshold.
 *  Pass a `budget-pressure` policy, or a tail wholly inside the retention
 *  window answers false and the size bound refuses every append until it ages
 *  out — two hours of a session the user cannot write to. */
export function journalTailCanShedRows(
  tailRows: readonly JournalRow[],
  policy: JournalCompactionPolicy,
  now: number
): boolean {
  return retainTail(tailRows, policy, now).length < tailRows.length
}
