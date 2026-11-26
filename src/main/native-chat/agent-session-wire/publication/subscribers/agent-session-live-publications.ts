import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import { backgroundTaskFingerprint } from './agent-session-subscriber-frame-fields'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { publishSubscriberLiveText } from './agent-session-subscriber-live-text'
import type { AgentSessionBackgroundTaskState } from '../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { commandDetailsAvailableEqual } from '../../../../../shared/agent-session/background-tasks/agent-session-command-details'

/** A credited reader emits on a changed fence even when its projected state is unchanged. */
function owesBackgroundTasks(
  subscriber: Subscriber,
  stateDiffers: boolean,
  fence: number
): boolean {
  return stateDiffers || (subscriber.detailCredit === true && fence !== subscriber.creditedFence)
}

/** Fence and roster (or availability) are sampled together when the entry runs, never at enqueue. */
export async function republishSubscriberBackgroundTasks(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  sessionId: string,
  hostNow: number
): Promise<void> {
  const read = port.hooks.readBackgroundTaskLane?.(sessionId)
  if (!read) {
    return
  }
  let backgroundTasks: AgentSessionBackgroundTaskState | null
  if (read.kind === 'roster') {
    const projected = subscriber.projectBackgroundTasks
      ? subscriber.projectBackgroundTasks(read.state)
      : read.state
    const differs = subscriber.backgroundTasks !== backgroundTaskFingerprint(projected)
    if (!owesBackgroundTasks(subscriber, differs, read.fence)) {
      return
    }
    backgroundTasks = read.state
  } else {
    // Without the conversation only credited readers are re-derived; their Dock rows replay as sent.
    const credited = subscriber.creditedRoster
    if (!subscriber.detailCredit || !credited) {
      return
    }
    const before = credited.commandDetailsAvailable ?? []
    const kept = read.keep(before)
    const differs = !commandDetailsAvailableEqual(kept, before)
    if (!owesBackgroundTasks(subscriber, differs, read.fence)) {
      return
    }
    const { commandDetailsAvailable: _previous, ...rows } = credited
    backgroundTasks = kept.length > 0 ? { ...rows, commandDetailsAvailable: kept } : rows
  }
  await port.emit(subscriber, {
    type: 'batch',
    sessionId,
    batch: emptyAgentSessionBatch(subscriber.cursor),
    fence: read.fence,
    backgroundTasks,
    hostNow
  })
  subscriber.fence = read.fence
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
