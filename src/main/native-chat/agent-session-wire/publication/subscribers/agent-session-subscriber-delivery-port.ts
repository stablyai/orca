import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
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
  let queue: Promise<QueuePublication | undefined> | undefined
  let framed: { key: string; value: Promise<QueuePublication | null | undefined> } | undefined
  const readWork = () =>
    (work ??= Promise.resolve(
      sessionId && journal ? base.hooks.readCurrentWork?.(sessionId, journal) : null
    ).then((value) => value ?? null))
  const readQueue = base.hooks.readQueuePublication
  // Frames at one complete work identity and queue revision share one in-lane queue answer.
  const captureQueue = readQueue
    ? (id: string, current: StructuredAgentSessionObservedWork | undefined) => {
        const key = journal && frameQueueKey(journal, current)
        if (key === undefined || framed?.key !== key) {
          const value = Promise.resolve(readQueue(id, current, true))
          const entry = key === undefined ? undefined : { key, value }
          framed = entry
          // A superseded answer is that attempt's alone; the next capture reads again.
          void value.then((answer) => {
            if (answer === null && framed === entry) {
              framed = undefined
            }
          })
          return value
        }
        return framed.value
      }
    : undefined
  const hooks: SubscriberDeliveryPort['hooks'] =
    sessionId && journal
      ? {
          ...base.hooks,
          readCurrentWork: readWork,
          readQueuePublication: queueChanged
            ? () =>
                (queue ??= readWork().then(
                  async (value) =>
                    (await base.hooks.readQueuePublication?.(sessionId, value ?? undefined)) ??
                    undefined
                ))
            : undefined,
          captureQueuePublication: queueChanged ? captureQueue : undefined
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

function frameQueueKey(
  journal: SqlAgentSessionJournal,
  work: StructuredAgentSessionObservedWork | undefined
): string | undefined {
  const source = work?.readSource
  if (work && !source) {
    return undefined
  }
  return JSON.stringify([
    source && [source.cursor, source.physicalCursor, source.authority],
    journal.cursor(),
    journal.physicalCursor(),
    journal.queuedMessages.revision(),
    journal.reopenFloor()
  ])
}
