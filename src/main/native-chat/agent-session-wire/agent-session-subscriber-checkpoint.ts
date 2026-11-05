import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionTurnActivity } from '../../../shared/agent-session/agent-session-wire'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'
import type { AgentSessionPublishedWork } from './agent-session-published-work'
import { subscriberCommandsChanged } from './agent-session-subscriber-frame-fields'
import { refreshPublishedWorkSteps } from './agent-session-work-refresh'
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
  finishJournalSteps(emitCaughtUpSteps(port, subscriber, emitCheckpoint, shared, current))
}
export function* emitCaughtUpSteps(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  emitCheckpoint: boolean,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null },
  current: { journal: AgentSessionJournal; work: AgentSessionPublishedWork | undefined }
): Generator<void> {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  const queued = port.hooks.readQueuePublicationSteps
    ? yield* port.hooks.readQueuePublicationSteps(subscriber.sessionId)
    : port.hooks.readQueuePublication?.(subscriber.sessionId)
  const queuedChanged = queued !== subscriber.queuePublication
  // Ownership/exit changes without rows still require current-work restatement.
  const { work } = current
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    yield* refreshPublishedWorkSteps(port, subscriber, current.journal, work, shared)
    return
  }
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    const args: Parameters<SubscriberDeliveryPort['emit']> = [
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        ...shared
      },
      { currentWork: work, journal: current.journal }
    ]
    if (port.emitSteps) {
      yield* port.emitSteps(...args)
    } else {
      port.emit(...args)
    }
  }
}
