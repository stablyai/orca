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
  const readWork = () =>
    (work ??= Promise.resolve(
      sessionId && journal ? base.hooks.readCurrentWork?.(sessionId, journal) : null
    ).then((value) => value ?? null))
  const hooks =
    sessionId && journal
      ? {
          ...base.hooks,
          readCurrentWork: readWork,
          readQueuePublication: queueChanged
            ? () =>
                (queue ??= readWork().then((value) =>
                  base.hooks.readQueuePublication?.(sessionId, value ?? undefined)
                ))
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
