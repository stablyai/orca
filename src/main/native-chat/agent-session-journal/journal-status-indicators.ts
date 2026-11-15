import type { StructuredAgentSessionWorkScope } from '../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { structuredAgentSessionStoppingForMark } from '../agent-session-wire/termination/structured-agent-session-stopping'
import type { JournalReducerState } from './projection/journal-reducer'
import { renderJournalStatus, renderJournalStatusItem } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalContextCursor } from './context-epochs/journal-context-epoch'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'

export type JournalStatusIndicatorRead = {
  start: number
  floor: number
  /** The host's row-free settlement state accompanies its latest persisted Stop. */
  stop?: JournalLatestStop | null
}
export type JournalStatusIndicators = {
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
}

export function readJournalStatusIndicators(
  state: JournalReducerState,
  input: JournalStatusIndicatorRead,
  scope?: StructuredAgentSessionWorkScope
): JournalStatusIndicators {
  const order = journalInputOrder(state)
  const { epoch } = journalContextCursor(state)
  const snapshot = renderJournalStatus(state, order)
  const stop = input.stop === undefined ? state.queuePauseMarks.latestStop : input.stop
  const failed = stop?.settle?.failedOn
  const submissions = order.statusInputs(
    state,
    snapshot.items,
    failed && 'openedAfter' in failed ? failed.openedAfter : undefined
  )
  const candidates = submissions
    .map((send) => ({ send, ordinal: order.inputOrdinal(send.clientMessageId) }))
    .filter(({ ordinal }) => ordinal >= input.start)
    .sort((a, b) => a.ordinal - b.ordinal)
  let first: string | null = null
  for (const { send } of candidates) {
    const item =
      renderJournalStatusItem(state, agentJournalSubmissionKey(send.clientMessageId)) ??
      (send.providerItemId ? renderJournalStatusItem(state, send.providerItemId) : null)
    if (
      item &&
      item.sequence > input.floor &&
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item) &&
      !isStructuredAgentSessionCommandEntry(item.body)
    ) {
      first = send.clientMessageId
      break
    }
  }
  return {
    acceptedSendKey: `${epoch}:${submissions.findLast((send) => send.dispatchState === 'accepted')?.clientMessageId ?? ''}`,
    firstInputSubmissionKey: first === null ? null : JSON.stringify([epoch, first]),
    submissionCount: order.inputCount(),
    stopping: structuredAgentSessionStoppingForMark(stop, snapshot.items, submissions, scope)
  }
}
