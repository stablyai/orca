import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import {
  backgroundTaskFingerprint,
  subscriberCommandsChanged,
  type SubscriberFieldHooks
} from './agent-session-subscriber-frame-fields'
import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { publishSubscriberLiveText } from './agent-session-subscriber-live-text'

export async function republishSubscriberBackgroundTasks(
  port: SubscriberDeliveryPort,
  subscribers: readonly Subscriber[],
  sessionId: string,
  fence: number,
  hostNow: number
): Promise<void> {
  const state = port.hooks.readBackgroundTasks?.(sessionId)
  if (state === undefined) {
    return
  }
  const fingerprint = backgroundTaskFingerprint(state)
  for (const subscriber of subscribers) {
    if (subscriber.backgroundTasks === fingerprint) {
      continue
    }
    await port.emit(subscriber, {
      type: 'batch',
      sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence,
      backgroundTasks: state,
      hostNow
    })
    subscriber.fence = fence
  }
}

export function createSubscriberLiveTextPublisher(
  port: () => SubscriberDeliveryPort,
  subscribers: (sessionId: string) => Subscriber[],
  now: () => number
) {
  return (
    sessionId: string,
    journal: AgentSessionJournal,
    fence: number,
    items: readonly AgentJournalRenderItem[],
    targets = subscribers(sessionId)
  ): Promise<void> =>
    publishSubscriberLiveText(port(), {
      sessionId,
      journal,
      fence,
      items,
      subscribers: targets,
      hostNow: now()
    })
}

export function subscriberCommandRefresh(
  hooks: SubscriberFieldHooks,
  subscriber: Subscriber,
  hostNow: number,
  retired?: (sessionId: string) => boolean
): (() => AgentSessionSubscribeEvent) | undefined {
  const { sessionId, commandsOnRequest } = subscriber
  const invalidated = commandsOnRequest && retired?.(sessionId)
  if (invalidated || subscriberCommandsChanged(hooks, subscriber)) {
    return () => ({
      type: 'batch',
      sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence: subscriber.fence,
      hostNow,
      ...(invalidated ? { commandsChanged: true as const } : {})
    })
  }
  return undefined
}
