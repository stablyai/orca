import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalReducerState } from './journal-reducer'
import { buildJournalItemRow, buildJournalTombstoneRow } from './journal-row-builders'
import type { JournalRowWriter, JournalOperationReceipt } from './journal-row-writer'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'
import { journalQueuePauseRestatement } from './queued-message-pause'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalRow } from './journal-row-schema'

export async function rewindJournalContext(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  floor: AgentJournalCursor
  fence: number
  items: readonly JournalReplacementItem[]
  receipt: (cursor: AgentJournalCursor) => JournalOperationReceipt
}): Promise<AgentJournalCursor> {
  let receipt: JournalOperationReceipt | undefined
  const rows = await input.writer.enqueueRows(
    () => {
      const state = input.state()
      if (state.epoch !== input.floor.epoch || !state.queuePauseMarks.cleared) {
        throw new Error('agent_session_rewind:stale-context')
      }
      const pause = journalQueuePauseRestatement(
        state.queuePauseMarks,
        state.latestAcceptedTurnSequence,
        input.cards.pauses()
      ).cleared!
      const removed = new Map<string, boolean>()
      for (const item of state.items.values()) {
        if (item.sequence > input.floor.sequence) {
          removed.set(item.itemId, false)
        }
      }
      for (const submission of state.submissions.values()) {
        if ((submission.acceptedSequence ?? 0) > input.floor.sequence) {
          removed.set(agentJournalSubmissionKey(submission.clientMessageId), true)
        }
      }
      const revisions = new Map<string, number>()
      const plan: ((seq: number, ts: number) => JournalRow)[] = []
      for (const [itemId, retireSubmission] of removed) {
        const row = buildJournalTombstoneRow({ state, itemId, seq: 0, ts: 0, fence: input.fence })
        revisions.set(itemId, row.revision)
        plan.push((seq, ts) => ({
          ...row,
          seq,
          ts,
          ...(retireSubmission ? { retireSubmission: true } : {})
        }))
      }
      for (const item of input.items) {
        const itemId = agentJournalItemKey(item.identity)
        const existing = state.items.get(itemId)
        if (existing && existing.sequence <= input.floor.sequence) {
          throw new Error('agent_session_rewind:proof-mismatch')
        }
        const revision =
          Math.max(
            revisions.get(itemId) ?? 0,
            state.tombstones.get(itemId) ?? 0,
            existing?.revision ?? 0
          ) + 1
        revisions.set(itemId, revision)
        plan.push((seq, ts) => ({
          ...buildJournalItemRow({
            state,
            ...item,
            linkage: item,
            seq,
            ts: item.observedAt ?? ts,
            fence: input.fence,
            turnScope: item.turnScope ?? { kind: 'thread' }
          }),
          revision
        }))
      }
      plan.push((seq, ts) =>
        buildJournalQueueClearRow({ state, seq, ts, fence: input.fence, clear: pause })
      )
      receipt = input.receipt({ epoch: state.epoch, sequence: state.lastSequence + plan.length })
      return plan
    },
    {
      write: (db) => receipt!.write(db),
      committed: () => receipt!.committed()
    }
  )
  const last = rows.at(-1)!
  return { epoch: last.epoch, sequence: last.seq }
}
