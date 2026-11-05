import { journalInputOrder } from './journal-input-order-owner'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalReducerState } from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalTombstoneRow,
  journalRowBase
} from './journal-row-builders'
import type {
  JournalRowWriter,
  JournalOperationReceipt,
  JournalFinishFold
} from './journal-row-writer'
import { composeJournalOperationReceipts } from './journal-row-writer'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'
import { journalQueuePauseRestatementSteps } from './queued-message-pause'
import type { JournalQueuedMessages } from './journal-queued-messages'
import { journalContextCursor, journalContextEpoch } from './journal-context-cursor'
import { sameJournalConversation } from './journal-history-origin'
import { journalItemEchoRestatement } from './journal-item-echo'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalEpochRow, JournalRow } from './journal-row-schema'

export async function rewindJournalContext(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  floor?: AgentJournalCursor
  boundary?: Pick<JournalEpochRow, 'reason' | 'providerHandle'>
  fence: number
  items: readonly JournalReplacementItem[]
  inputReceipt: (
    rows: readonly JournalRow[],
    receipt?: JournalOperationReceipt
  ) => JournalOperationReceipt | undefined | Promise<JournalOperationReceipt | undefined>
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
}): Promise<AgentJournalCursor> {
  let retainFailures: JournalFinishFold | undefined
  const rows = await input.writer.enqueueRows(
    async () => {
      const pauses = await input.cards.pausesAsync()
      return (function* () {
        const state = input.state()
        const floor = input.floor
        if (
          floor &&
          (journalContextCursor(state).epoch !== floor.epoch || !state.queuePauseMarks.cleared)
        ) {
          throw new Error('agent_session_rewind:stale-context')
        }
        const { cleared } = yield* journalQueuePauseRestatementSteps(
          state.queuePauseMarks,
          state.latestAcceptedTurnSequence,
          pauses
        )
        const retained = yield* journalInputOrder(state).newestTurn.retainFailuresSteps(
          state,
          (function* () {
            for (const item of input.items) {
              yield agentJournalItemKey(item.identity)
            }
          })()
        )
        retainFailures = (draft) => retained(journalInputOrder(draft).newestTurn, draft)
        const queued = new Set<string>()
        for (const entry of journalInputOrder(state).recoverableSubmissionValues()) {
          if (isQueuedAgentJournalSubmission(entry)) {
            queued.add(agentJournalSubmissionKey(entry.clientMessageId))
          }
          yield
        }
        const removed = new Set<string>()
        for (const item of state.items.values()) {
          yield
          if (item.sequence > (floor?.sequence ?? 0) && !queued.has(item.itemId)) {
            removed.add(item.itemId)
          }
        }
        const revisions = new Map<string, number>()
        const boundary = input.boundary
        if (boundary) {
          const previous = state.historyOrigin
          const historyOrigin =
            previous && sameJournalConversation(previous.providerHandle, boundary.providerHandle)
              ? { historyOrigin: previous.raw }
              : {}
          yield (seq: number, ts: number) => ({
            kind: 'epoch',
            ...boundary,
            ...historyOrigin,
            reason:
              boundary.reason === 'legacy_import' && !input.items.length
                ? 'session_created'
                : boundary.reason,
            ...journalRowBase(state.epoch, seq, input.fence, ts)
          })
        }
        for (const itemId of removed) {
          const row = buildJournalTombstoneRow({ state, itemId, seq: 0, ts: 0, fence: input.fence })
          revisions.set(itemId, row.revision)
          yield (seq: number, ts: number) => ({ ...row, seq, ts })
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
          yield (seq: number, ts: number) => ({
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
          })
        }
        if (cleared) {
          yield (seq: number, ts: number) =>
            buildJournalQueueClearRow({ state, seq, ts, fence: input.fence, clear: cleared })
        }
      })()
    },
    async (rows) => {
      const state = input.state()
      const receipt = input.receipt?.({
        epoch: input.boundary
          ? journalContextEpoch(state.epoch, state.lastSequence + 1)
          : journalContextCursor(state).epoch,
        sequence: rows.at(-1)?.seq ?? state.lastSequence
      })
      const foldReceipt: JournalOperationReceipt = {
        replacement: true,
        fold: (draft) => retainFailures?.(draft),
        write: () => {},
        committed: () => {}
      }
      const inputReceipt = await input.inputReceipt(rows, receipt)
      return composeJournalOperationReceipts(foldReceipt, ...(inputReceipt ? [inputReceipt] : []))
    }
  )
  const last = rows.at(-1)!
  return { epoch: last.epoch, sequence: last.seq }
}
