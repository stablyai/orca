import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import {
  measureHistoryItem,
  oversizedHistoryItem
} from '../history/agent-session-history-page-bounds'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import { agentSessionPublishedWorkFields } from '../../observations/agent-session-published-work'
import {
  deliverToSubscriber,
  type SubscriberDeliveryPort
} from './agent-session-subscriber-catch-up'
import type { SubscriberFrameCapture } from './agent-session-subscriber-frame-capture'
import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import type { Subscriber } from './agent-session-subscribe-input'

/** A resume catches up, then corrects notes only at a delivered frame's position. An abandoned frame
 *  is replaced by its invalidation's delivery; a passed one catches up first, which takes a new
 *  commit or authority change per round. */
export async function resumeSubscriber(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  refreshForkMarkers: () => Promise<void>
): Promise<void> {
  let frame = await deliverToSubscriber(port, {
    subscriber,
    journal,
    hostNow,
    emitCheckpoint: true
  })
  await refreshForkMarkers()
  while (
    frame &&
    (await refreshDerivedStopNotes(port, subscriber, journal, hostNow, frame)) === 'moved'
  ) {
    frame = await deliverToSubscriber(port, { subscriber, journal, hostNow, emitCheckpoint: false })
  }
}

/** Correct notes after stale in-flight pages, at the position of the frame just delivered: each
 *  bounded page is read on the command lane while the journal is still there. Rows clear unstated
 *  work fields, so batches restate that frame's work; the queue stays as it delivered. `moved`:
 *  the journal or live authority passed the frame, so catch up before correcting notes again. */
export async function refreshDerivedStopNotes(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number,
  frame: Pick<SubscriberFrameCapture<unknown>, 'work' | 'current'>
): Promise<'done' | 'moved'> {
  const { form, budgetBytes } = subscriberHistoryReader(subscriber)
  const { work } = frame
  const fields = work ? agentSessionPublishedWorkFields(journal, work) : {}
  const at = { ...subscriber.cursor }
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
    const page = await journal.readInOrder((reads) =>
      sameJournalCursor(journal.cursor(), at) && frame.current()
        ? reads.projectedStopNotes(afterOrdinal)
        : null
    )
    if (!page) {
      return 'moved'
    }
    for (const item of page.items) {
      if (!port.isActive(subscriber)) {
        return 'done'
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
  return 'done'
}
