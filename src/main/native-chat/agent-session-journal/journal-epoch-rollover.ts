// Opening a new epoch.
//
// The snapshot is what names the live epoch, so it is published BEFORE the log
// is reset. A crash mid-rollover therefore leaves stale-epoch rows behind the
// new snapshot, which `loadJournal` drops — the reverse order would leave a
// journal whose log no longer matches any epoch anyone can name.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-journal-types'
import { pruneJournalBlobs } from './journal-blob-store'
import {
  rewriteJournalLog,
  writeJournalSnapshotFile,
  type JournalSnapshotFile
} from './journal-log-file'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

export async function publishNewEpoch(input: {
  journalDir: string
  sessionId: string
  providerHandle: AgentSessionProviderHandle
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  writeSnapshot?: typeof writeJournalSnapshotFile
  rewriteLog?: typeof rewriteJournalLog
  pruneBlobs?: typeof pruneJournalBlobs
}): Promise<{ state: JournalReducerState; row: JournalRow }> {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.providerHandle,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }
  const state = createJournalReducerState(input.sessionId, input.epoch)
  const snapshot: JournalSnapshotFile = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.epoch,
    compactedThrough: 1,
    items: [],
    submissions: [],
    receipts: [],
    aliases: [],
    tail: [row]
  }
  await (input.writeSnapshot ?? writeJournalSnapshotFile)(input.journalDir, snapshot)
  // The durable snapshot already made this epoch authoritative. A failed log
  // cleanup must not make the caller resume writes against the old in-memory
  // epoch; stale rows are safe because recovery filters them by snapshot epoch.
  await (input.rewriteLog ?? rewriteJournalLog)(input.journalDir, [row]).catch(() => undefined)
  await (input.pruneBlobs ?? pruneJournalBlobs)(input.journalDir, new Set())
  applyJournalRow(state, row)
  state.oldestSequence = 1
  return { state, row }
}
