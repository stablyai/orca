// Opening a new epoch.
//
// The snapshot is what names the live epoch, so it is published BEFORE the log
// is reset. A crash mid-rollover therefore leaves stale-epoch rows behind the
// new snapshot, which `loadJournal` drops — the reverse order would leave a
// journal whose log no longer matches any epoch anyone can name.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-journal-types'
import { compactJournal } from './journal-compaction'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { journalRowByteLength } from './journal-row-schema'
import type { JournalLoad } from './journal-open'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'

export async function publishNewEpoch(input: {
  journalDir: string
  sessionId: string
  providerHandle: AgentSessionProviderHandle
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
}): Promise<JournalLoad> {
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
  await compactJournal({
    journalDir: input.journalDir,
    state,
    tailRows: [row],
    policy: { minTailRows: 1, retainTailMs: Number.POSITIVE_INFINITY },
    now: input.now,
    maxSessionBytes: DEFAULT_JOURNAL_PAYLOAD_LIMITS.maxSessionBytes
  })
  applyJournalRow(state, row)
  state.oldestSequence = 1
  return {
    state,
    tailRows: [row],
    compactedThrough: 0,
    readOnly: false,
    corrupt: false,
    malformedRows: 0,
    sizeBytes: journalRowByteLength(row)
  }
}
