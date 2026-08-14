// Opening a new epoch.
//
// The snapshot is what names the live epoch, so it is published BEFORE the log
// is reset. A crash mid-rollover therefore leaves stale-epoch rows behind the
// new snapshot, which `loadJournal` drops — the reverse order would leave a
// journal whose log no longer matches any epoch anyone can name.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-journal-types'
import { compactJournal } from './journal-compaction'
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
  await compactJournal({
    journalDir: input.journalDir,
    state,
    tailRows: [row],
    policy: { minTailRows: 1, retainTailMs: Number.POSITIVE_INFINITY },
    now: input.now
  })
  applyJournalRow(state, row)
  state.oldestSequence = 1
  return { state, row }
}
