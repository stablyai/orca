import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { backgroundTaskFingerprint } from './agent-session-subscriber-frame-fields'
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
