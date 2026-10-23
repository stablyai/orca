import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalReducerState } from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalTombstoneRow,
  journalRowBase
} from './journal-row-builders'
import type { JournalRowWriter, JournalOperationReceipt } from './journal-row-writer'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'
import { journalQueuePauseRestatement } from './queued-message-pause'
import type { JournalQueuedMessages } from './journal-queued-messages'
import { journalContextCursor, journalContextEpoch } from './journal-context-cursor'
import { sameJournalConversation } from './journal-history-origin'
import { journalItemEchoRestatement } from './journal-item-echo'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { JournalEpochRow, JournalRow } from './journal-row-schema'

export async function rewindJournalContext(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards?: JournalQueuedMessages
  floor?: AgentJournalCursor
  boundary?: Pick<JournalEpochRow, 'reason' | 'providerHandle'>
  fence: number
  items: readonly JournalReplacementItem[]
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
}): Promise<AgentJournalCursor> {
  let receipt: JournalOperationReceipt | undefined
  const rows = await input.writer.enqueueRows(
    () => {
      const state = input.state()
      const floor = input.floor
      if (
        floor &&
        (journalContextCursor(state).epoch !== floor.epoch || !state.queuePauseMarks.cleared)
      ) {
        throw new Error('agent_session_rewind:stale-context')
      }
      const pause =
        floor && input.cards
          ? journalQueuePauseRestatement(
              state.queuePauseMarks,
              state.latestAcceptedTurnSequence,
              input.cards.pauses()
            ).cleared
          : null
      const queued = new Set(
        [...state.submissions.values()]
          .filter(isQueuedAgentJournalSubmission)
          .map((entry) => agentJournalSubmissionKey(entry.clientMessageId))
      )
      const removed = new Set<string>()
      for (const item of state.items.values()) {
        if (item.sequence > (floor?.sequence ?? 0) && !queued.has(item.itemId)) {
          removed.add(item.itemId)
        }
      }
      const revisions = new Map<string, number>()
      const plan: ((seq: number, ts: number) => JournalRow)[] = []
      const boundary = input.boundary
      if (boundary) {
        const previous = state.historyOrigin
        const historyOrigin =
          previous && sameJournalConversation(previous.providerHandle, boundary.providerHandle)
            ? { historyOrigin: previous.raw }
            : {}
        plan.push((seq, ts) => ({
          kind: 'epoch',
          ...boundary,
          ...historyOrigin,
          reason:
            boundary.reason === 'legacy_import' && !input.items.length
              ? 'session_created'
              : boundary.reason,
          ...journalRowBase(state.epoch, seq, input.fence, ts)
        }))
      }
      for (const itemId of removed) {
        const row = buildJournalTombstoneRow({ state, itemId, seq: 0, ts: 0, fence: input.fence })
        revisions.set(itemId, row.revision)
        plan.push((seq, ts) => ({ ...row, seq, ts }))
      }
      const scope = new JournalDerivedTurnScope()
      for (const item of input.items) {
        const itemId = agentJournalItemKey(item.identity)
        const existing = state.items.get(itemId)
        if (floor && existing && existing.sequence <= floor.sequence) {
          throw new Error('agent_session_rewind:proof-mismatch')
        }
        const revision =
          Math.max(
            revisions.get(itemId) ?? 0,
            state.tombstones.get(itemId) ?? 0,
            existing?.revision ?? 0
          ) + 1
        revisions.set(itemId, revision)
        const turnScope = item.turnScope ?? scope.scopeFor(item.body)
        scope.observe(itemId, isRootAgentJournalItem(item), undefined, item.body)
        plan.push((seq, ts) => ({
          ...buildJournalItemRow({
            state,
            ...item,
            ...journalItemEchoRestatement(state.itemEchoes, itemId),
            linkage: item,
            seq,
            ts: item.observedAt ?? ts,
            fence: input.fence,
            turnScope
          }),
          revision
        }))
      }
      if (pause) {
        plan.push((seq, ts) =>
          buildJournalQueueClearRow({ state, seq, ts, fence: input.fence, clear: pause })
        )
      }
      receipt = input.receipt?.({
        epoch: boundary
          ? journalContextEpoch(state.epoch, state.lastSequence + 1)
          : journalContextCursor(state).epoch,
        sequence: state.lastSequence + plan.length
      })
      return plan
    },
    {
      write: (db) => {
        receipt?.write(db)
      },
      committed: () => {
        receipt?.committed()
      }
    }
  )
  const last = rows.at(-1)!
  return { epoch: last.epoch, sequence: last.seq }
}
