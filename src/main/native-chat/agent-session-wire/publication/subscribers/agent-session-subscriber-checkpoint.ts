import type { AgentSessionTurnActivity } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { subscriberCommandsChanged } from './agent-session-subscriber-frame-fields'
import { refreshPublishedWork } from './agent-session-work-refresh'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { SubscriberFrameCapture } from './agent-session-subscriber-frame-capture'
import type { Subscriber } from './agent-session-subscribe-input'

/** Every emission of a captured frame, restatements included, carries its own work and queue. */
export function capturedSubscriberPort(
  port: SubscriberDeliveryPort,
  journal: AgentSessionJournal,
  frame: SubscriberFrameCapture<unknown>
): SubscriberDeliveryPort {
  return {
    ...port,
    emit: (target, event, options) =>
      port.emit(target, event, {
        ...options,
        currentWork: frame.work,
        journal,
        ...(frame.queue ? { queuePublication: frame.queue } : {})
      })
  }
}

export async function emitCaughtUp(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  emitCheckpoint: boolean,
  shared: {
    hostNow: number
    activity?: AgentSessionTurnActivity | null
  },
  frame: SubscriberFrameCapture<unknown>
): Promise<void> {
  const commandsChanged = subscriberCommandsChanged(port.hooks, subscriber)
  // Ownership/exit changes without rows still require current-work restatement.
  const { work, queue } = frame
  const workChanged = work !== undefined && work.workViewKey() !== subscriber.workView
  if (workChanged) {
    await refreshPublishedWork(
      capturedSubscriberPort(port, journal, frame),
      subscriber,
      journal,
      work,
      frame.current,
      shared,
      frame.queue
    )
    return
  }
  const queuedChanged = queue !== undefined && queue.value !== subscriber.queuePublication
  if (emitCheckpoint || shared.activity !== undefined || commandsChanged || queuedChanged) {
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        ...shared
      },
      { currentWork: work, ...(queue ? { queuePublication: queue } : {}) }
    )
  }
}
