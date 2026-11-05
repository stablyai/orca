import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { measureHistoryItem, oversizedHistoryItem } from './agent-session-history-page-bounds'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import {
  agentSessionPublishedWorkFieldSteps,
  capturePublishedWorkSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'

/** Correct notes after stale in-flight pages; restate current work so rows retain modern-host semantics. */
export function refreshDerivedStopNotes(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  work?: AgentSessionPublishedWork
): void {
  finishJournalSteps(refreshDerivedStopNoteSteps(port, subscriber, journal, hostNow, work))
}
export function* refreshDerivedStopNoteSteps(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'emitSteps' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  work?: AgentSessionPublishedWork
): Generator<void> {
  yield* journal.preparePublicReadSteps()
  const snapshot = journal.itemsRead()
  let hasUnconfirmedStop = false
  for (const item of snapshot.items) {
    const raw = journal.itemBody(item.itemId)
    if (
      raw?.kind === 'status' &&
      raw.failure?.kind === 'cancelUnconfirmed' &&
      isStructuredAgentSessionStopNote(item.itemId)
    ) {
      hasUnconfirmedStop = true
    }
    yield
  }
  if (!hasUnconfirmedStop) {
    return
  }
  work = yield* capturePublishedWorkSteps(journal.snapshot(), work)
  const fields = work ? yield* agentSessionPublishedWorkFieldSteps(journal, work) : {}
  const { form, budgetBytes } = subscriberHistoryReader(subscriber)
  let pending: AgentJournalRenderItem[] = []
  let bytes = 0
  const emit = function* (): Generator<void> {
    const args: Parameters<SubscriberDeliveryPort['emit']> = [
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), items: pending },
        fence: subscriber.fence,
        ...fields,
        hostNow
      },
      { currentWork: work, journal }
    ]
    if (port.emitSteps) {
      yield* port.emitSteps(...args)
    } else {
      port.emit(...args)
    }
    pending = []
    bytes = 0
  }
  for (const item of snapshot.items) {
    yield
    if (!port.isActive(subscriber)) {
      return
    }
    const raw = journal.itemBody(item.itemId)
    if (
      raw?.kind !== 'status' ||
      raw.failure?.kind !== 'cancelUnconfirmed' ||
      item.body.kind !== 'status' ||
      item.body.failure !== undefined
    ) {
      continue
    }
    const formed = form(item)
    const bounded =
      formed.bytes > budgetBytes ? measureHistoryItem(oversizedHistoryItem(formed.item)) : formed
    const itemBytes = bounded.bytes + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + itemBytes > budgetBytes)
    ) {
      yield* emit()
    }
    pending.push(bounded.item)
    bytes += itemBytes
  }
  if (pending.length > 0 && port.isActive(subscriber)) {
    yield* emit()
  }
}
