import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { copyFileDurable } from '../../durable-file-write'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { compactJournal, type JournalCompactionPolicy } from './journal-compaction'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE, appendJournalRows } from './journal-log-file'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { journalRowByteLength } from './journal-row-schema'
import { assertJournalFence, type JournalAppendBudget } from './journal-write-guards'
import type { JournalLoad } from './journal-open'

export type JournalReplacementItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
}

export async function replaceJournalEpoch(input: {
  journalDir: string
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  budget: JournalAppendBudget
  compaction: JournalCompactionPolicy
  now: () => number
  mintEpoch: () => string
  onSnapshotPublished: (loaded: JournalLoad) => void
}): Promise<void> {
  const stagingDir = await mkdtemp(join(input.journalDir, '.epoch-replacement-'))
  try {
    const epoch = input.mintEpoch()
    const state = createJournalReducerState(input.identity.sessionId, epoch)
    const epochRow: JournalRow = {
      kind: 'epoch',
      reason: input.reason,
      providerHandle: input.identity.providerHandle,
      ...journalRowBase(epoch, 1, input.fence, input.now())
    }
    const rows: JournalRow[] = [epochRow]
    applyJournalRow(state, epochRow)
    let sizeBytes = journalRowByteLength(epochRow)
    await appendJournalRows(stagingDir, [epochRow])

    for (const item of input.items) {
      const appendTime = input.now()
      const row = buildJournalItemRow({
        state,
        identity: item.identity,
        body: item.body,
        seq: state.lastSequence + 1,
        fence: input.fence,
        ts: item.observedAt ?? appendTime
      })
      assertJournalFence(row.fence, state.highestFence)
      input.budget.assert(row, appendTime, sizeBytes)
      await appendJournalRows(stagingDir, [row])
      applyJournalRow(state, row)
      rows.push(row)
      sizeBytes += journalRowByteLength(row)
    }

    const compacted = await compactJournal({
      journalDir: stagingDir,
      state,
      tailRows: rows,
      policy: input.compaction,
      now: input.now(),
      maxSessionBytes: input.budget.maxSessionBytes
    })
    await publishPreparedFile(stagingDir, input.journalDir, JOURNAL_SNAPSHOT_FILE)
    state.oldestSequence = compacted.oldestSequence
    input.onSnapshotPublished({
      state,
      tailRows: compacted.tailRows,
      compactedThrough: compacted.compactedThrough,
      readOnly: false,
      corrupt: false,
      malformedRows: 0,
      sizeBytes: compacted.tailRows.reduce((total, row) => total + journalRowByteLength(row), 0)
    })
    await publishPreparedFile(stagingDir, input.journalDir, JOURNAL_LOG_FILE)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

async function publishPreparedFile(
  stagingDir: string,
  journalDir: string,
  fileName: string
): Promise<void> {
  const copied = await copyFileDurable(join(stagingDir, fileName), join(journalDir, fileName))
  if (!copied) {
    throw new Error(`prepared journal file disappeared before publish: ${fileName}`)
  }
}
