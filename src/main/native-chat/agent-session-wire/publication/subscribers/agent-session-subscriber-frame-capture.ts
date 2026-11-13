import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { JournalDomainHistoryWork } from '../../../agent-session-journal/journal-domain-history-page'
import { AgentSessionJournalError } from '../../../agent-session-journal/writing/journal-write-guards'
import { journalOpenRefusalError } from '../../../agent-session-journal/replay/journal-open-failure'
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
  /** Whether live authority, the owning handle and the adopted cursor still match this frame. */
  current: () => boolean
}

type FrameCaptureHooks = Pick<
  SubscriberDeliveryPort['hooks'],
  'readWorkFrame' | 'captureQueuePublication'
>

/** A frame decorated after capture found the journal past it; its newer commit delivers again. */
export class SubscriberFrameSuperseded extends Error {
  constructor() {
    super('the journal moved past this frame before it was emitted')
    this.name = 'SubscriberFrameSuperseded'
  }
}

/** Hold the chat's lane for one bounded read of rows, work and queue, then release it before any
 *  emission. Undefined abandons the frame: not `live`, a closed or replaced journal, or live
 *  authority that changed during any part of the read, whose own publication schedules the
 *  replacement. */
export async function captureJournalFrame<T>(
  hooks: FrameCaptureHooks,
  sessionId: string,
  journal: AgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>,
  live: () => boolean = () => true
): Promise<SubscriberFrameCapture<T> | undefined> {
  const open = () => live() && !journal.isClosed
  if (!open()) {
    return undefined
  }
  let captured: SubscriberFrameCapture<T> | undefined
  try {
    captured = await journal.readInOrder(async () => {
      if (!open()) {
        return undefined
      }
      const frame = await readWorkFrame(hooks, sessionId, journal, rows)
      if (!frame || !open()) {
        return undefined
      }
      const capture = hooks.captureQueuePublication
      if (!capture) {
        return frame
      }
      const queue = await capture(sessionId, frame.work)
      // The queue was read at this frame's authority; nothing may have moved since.
      return queue !== null && open() && frame.current()
        ? { ...frame, queue: { value: queue } }
        : undefined
    })
  } catch (error) {
    if (error instanceof AgentSessionJournalError && journal.isClosed) {
      return undefined
    }
    throw error
  }
  return captured && open() ? captured : undefined
}

export function captureSubscriberFrame<T>(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>
): Promise<SubscriberFrameCapture<T> | undefined> {
  return captureJournalFrame(port.hooks, subscriber.sessionId, journal, rows, () =>
    port.isActive(subscriber)
  )
}

async function readWorkFrame<T>(
  hooks: FrameCaptureHooks,
  sessionId: string,
  journal: AgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>
): Promise<SubscriberFrameCapture<T> | null> {
  const reader = hooks.readWorkFrame
  if (!reader) {
    return { work: undefined, value: (await rows(undefined)).result, current: () => true }
  }
  const frame = await reader(sessionId, journal, async (work) => {
    const read = await rows(work)
    return { value: read.result, ...(read.work ? { work: read.work } : {}) }
  })
  return frame && { work: frame.work ?? undefined, value: frame.value, current: frame.current }
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

const REQUEST_FRAME_ATTEMPTS = 3

/** A request answers once, so it takes another capture only after one was abandoned because live
 *  authority moved; persistent churn refuses as retryable unavailable history, never mixed state. */
export async function captureRequestFrame<T>(
  journal: AgentSessionJournal,
  capture: () => Promise<T | undefined>
): Promise<T> {
  for (let attempt = 0; attempt < REQUEST_FRAME_ATTEMPTS; attempt += 1) {
    if (journal.isClosed) {
      break
    }
    const captured = await capture()
    if (captured !== undefined) {
      return captured
    }
  }
  if (journal.isClosed) {
    throw new AgentSessionJournalError(
      'journal_closed',
      `the journal for ${journal.identity.sessionId} is closed`
    )
  }
  throw journalOpenRefusalError(new Error('live work kept changing while this chat frame was read'))
}
