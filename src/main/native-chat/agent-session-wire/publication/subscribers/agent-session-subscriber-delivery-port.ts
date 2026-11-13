import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { sameJournalCursor } from '../../../agent-session-journal/replay/journal-cursor'
import type { StructuredAgentSessionObservedWork } from '../../observations/structured-agent-session-observed-work'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'

/** One durable fan-out shares its finished reads; text-only commits keep delivered queue state. */
export function subscriberDeliveryPort(
  base: Omit<SubscriberDeliveryPort, 'emit'> & {
    emit: (
      ...args: [...Parameters<SubscriberDeliveryPort['emit']>, SubscriberDeliveryPort['hooks']]
    ) => Promise<void>
  },
  sessionId?: string,
  journal?: SqlAgentSessionJournal,
  queueChanged = true
): SubscriberDeliveryPort {
  let work: Promise<StructuredAgentSessionObservedWork | null> | undefined
  let queue:
    | {
        work: StructuredAgentSessionObservedWork | null
        value: Promise<QueuePublication | undefined>
      }
    | undefined
  const read = () =>
    Promise.resolve(
      sessionId && journal ? base.hooks.readCurrentWork?.(sessionId, journal) : null
    ).then((value) => value ?? null)
  const readWork = async () => {
    const shared = (work ??= read())
    const value = await shared
    // A commit adopted since the shared answer makes it stale for every later reader.
    if (value && journal && !sameJournalCursor(value.cursor, journal.cursor())) {
      if (work === shared) {
        work = read()
      }
      return work
    }
    return value
  }
  const readWorkFrame = base.hooks.readWorkFrame
  const hooks: SubscriberDeliveryPort['hooks'] =
    sessionId && journal
      ? {
          ...base.hooks,
          readCurrentWork: readWork,
          // A frame's answer is current at the adopted cursor, so later readers share it.
          ...(readWorkFrame
            ? {
                readWorkFrame: async (id, source, rows) => {
                  const frame = await readWorkFrame(id, source, rows)
                  const shared = await work
                  if (
                    frame.work &&
                    sameJournalCursor(frame.work.cursor, journal.cursor()) &&
                    !sameWorkCursor(shared ?? null, frame.work)
                  ) {
                    work = Promise.resolve(frame.work)
                  }
                  return frame
                }
              }
            : {}),
          // The queue is read with the shared work answer and follows it to newer cursors.
          readQueuePublication: queueChanged
            ? async () => {
                const current = await readWork()
                if (!queue || !sameWorkCursor(queue.work, current)) {
                  queue = {
                    work: current,
                    value: Promise.resolve(
                      base.hooks.readQueuePublication?.(sessionId, current ?? undefined)
                    )
                  }
                }
                return queue.value
              }
            : undefined
        }
      : base.hooks
  return {
    ...base,
    hooks,
    emit: (target, event, options) =>
      base.emit(
        target,
        event,
        {
          ...options,
          ...(!queueChanged ? { queuePublication: { value: target.queuePublication } } : {})
        },
        hooks
      )
  }
}

function sameWorkCursor(
  a: StructuredAgentSessionObservedWork | null,
  b: StructuredAgentSessionObservedWork | null
): boolean {
  return a === b || (a !== null && b !== null && sameJournalCursor(a.cursor, b.cursor))
}
