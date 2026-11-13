import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { JournalDomainHistoryWork } from '../../../agent-session-journal/journal-domain-history-page'
import { AgentSessionJournalError } from '../../../agent-session-journal/writing/journal-write-guards'
import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import type { AgentSessionHistoryFrame } from '../history/agent-session-history-page'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './agent-session-subscribe-input'

/** Everything one delivered frame carries, captured at a single adopted command-lane position. */
export type SubscriberFrameCapture<T> = {
  value: T
  work: StructuredAgentSessionObservedWork | undefined
  queue?: { value: QueuePublication | undefined }
}

/** Hold the chat's lane for one bounded read of rows, work and queue, then release it before any
 *  emission. Undefined abandons the frame: an inactive subscriber, a closed or replaced journal, or
 *  live authority that changed mid-read, whose own publication schedules the replacement. */
export async function captureSubscriberFrame<T>(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>
): Promise<SubscriberFrameCapture<T> | undefined> {
  const live = () => port.isActive(subscriber) && !journal.isClosed
  if (!live()) {
    return undefined
  }
  let captured: SubscriberFrameCapture<T> | undefined
  try {
    captured = await journal.readInOrder(async () => {
      if (!live()) {
        return undefined
      }
      const frame = await readWorkFrame(port, subscriber.sessionId, journal, rows)
      if (!frame || !live()) {
        return undefined
      }
      const capture = port.hooks.captureQueuePublication
      if (!capture) {
        return frame
      }
      const queue = await capture(subscriber.sessionId, frame.work)
      return live() ? { ...frame, queue: { value: queue } } : undefined
    })
  } catch (error) {
    if (error instanceof AgentSessionJournalError && journal.isClosed) {
      return undefined
    }
    throw error
  }
  return captured && live() ? captured : undefined
}

async function readWorkFrame<T>(
  port: SubscriberDeliveryPort,
  sessionId: string,
  journal: AgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>
): Promise<SubscriberFrameCapture<T> | null> {
  const reader = port.hooks.readWorkFrame
  if (!reader) {
    return { work: undefined, value: (await rows(undefined)).result }
  }
  const frame = await reader(sessionId, journal, async (work) => {
    const read = await rows(work)
    return { value: read.result, ...(read.work ? { work: read.work } : {}) }
  })
  return frame && { work: frame.work ?? undefined, value: frame.value }
}

/** Caught-up frames carry no rows; a current cached answer needs no read. */
export async function readCaughtUpWork(
  journal: AgentSessionJournal,
  work: JournalDomainHistoryWork | undefined
): Promise<AgentSessionHistoryFrame<undefined>> {
  return {
    result: undefined,
    ...(work && !work.unlessAt ? { work: await journal.reads.work(work.read) } : {})
  }
}
