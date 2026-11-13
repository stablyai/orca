import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import {
  measureHistoryItem,
  oversizedHistoryItem
} from '../history/agent-session-history-page-bounds'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from '../../observations/agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './agent-session-subscribe-input'

/** Correct notes after stale in-flight pages. Rows clear unstated work fields, so restate those of
 *  the frame captured at the subscriber's cursor; the queue stays as that frame delivered it. */
export async function refreshDerivedStopNotes(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  work: AgentSessionPublishedWork | undefined
): Promise<void> {
  const { form, budgetBytes } = subscriberHistoryReader(subscriber)
  const fields = work ? agentSessionPublishedWorkFields(journal, work) : {}
  let pending: AgentJournalRenderItem[] = []
  let bytes = 0
  const emit = async (): Promise<void> => {
    if (!port.isActive(subscriber)) {
      return
    }
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), items: pending },
        fence: subscriber.fence,
        ...fields,
        hostNow
      },
      { currentWork: work, journal, withholdQueued: true }
    )
    pending = []
    bytes = 0
  }
  let afterOrdinal = -1
  while (port.isActive(subscriber)) {
    const page = await journal.reads.projectedStopNotes(afterOrdinal)
    for (const item of page.items) {
      if (!port.isActive(subscriber)) {
        return
      }
      const formed = form(item)
      const bounded =
        formed.bytes > budgetBytes ? measureHistoryItem(oversizedHistoryItem(formed.item)) : formed
      const itemBytes = bounded.bytes + 1
      if (
        pending.length > 0 &&
        (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + itemBytes > budgetBytes)
      ) {
        await emit()
      }
      pending.push(bounded.item)
      bytes += itemBytes
    }
    if (page.nextOrdinal === null) {
      break
    }
    afterOrdinal = page.nextOrdinal
  }
  if (pending.length > 0) {
    await emit()
  }
}
