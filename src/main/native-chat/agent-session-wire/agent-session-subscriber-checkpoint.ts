import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'
import type { AgentSessionPublishedWork } from './agent-session-published-work'
import {
  subscriberCommandsChanged,
  subscriberQueuedMessagesChanged
} from './agent-session-subscriber-frame-fields'
import { refreshPublishedWork } from './agent-session-work-refresh'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'

export function emitCaughtUp(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  emitCheckpoint: boolean,
  shared: {
    hostNow: number
    activity?: AgentSessionTurnActivity | null
  },
  current: {
    journal: AgentSessionJournal
    work: AgentSessionPublishedWork | undefined
  }
): void {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  const queuedChanged = subscriberQueuedMessagesChanged(port.hooks, subscriber)
  // Ownership/exit changes without rows still require current-work restatement.
  const { work } = current
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    refreshPublishedWork(port, subscriber, current.journal, work, shared)
    return
  }
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        ...shared
      },
      { currentWork: work }
    )
  }
}
