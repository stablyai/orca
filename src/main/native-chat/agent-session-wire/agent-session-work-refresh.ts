import { backgroundTaskFingerprint } from './agent-session-subscriber-frame-fields'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../../shared/agent-session-current-requests-capability'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'

/** Restatements cannot share a history page's already allocated byte budget. */
export function refreshPublishedWork(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork | undefined,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null }
): void {
  if (!work || !port.isActive(subscriber)) {
    return
  }
  const view = work.workViewKey()
  const fields = agentSessionPublishedWorkFields(journal, work)
  const { budgetBytes } = subscriberHistoryReader(subscriber)
  let pending: AgentJournalSubmission[] = []
  let bytes = 0
  const emit = (): void => {
    port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), submissions: pending },
        fence: subscriber.fence,
        ...fields,
        ...shared
      },
      { currentWork: work }
    )
    pending = []
    bytes = 0
  }
  for (const submission of work.restatedSubmissions()) {
    const submissionBytes = Buffer.byteLength(JSON.stringify(submission), 'utf8') + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + submissionBytes > budgetBytes)
    ) {
      emit()
      if (!port.isActive(subscriber)) {
        return
      }
    }
    pending.push(submission)
    bytes += submissionBytes
  }
  // Empty work still owes its fields when ownership changed without a journal row.
  emit()
  if (port.isActive(subscriber)) {
    subscriber.workView = view
  }
}

export function republishCurrentRequestFrames(
  emit: SubscriberDeliveryPort['emit'],
  subscribers: Iterable<Subscriber>,
  sessionId: string,
  work: AgentSessionPublishedWork | undefined,
  hostNow: number
): void {
  if (!work) {
    return
  }
  for (const subscriber of subscribers) {
    if (subscriber.requestContract !== AGENT_SESSION_CURRENT_REQUESTS_V2) {
      continue
    }
    emit(
      subscriber,
      {
        type: 'batch',
        sessionId,
        batch: emptyAgentSessionBatch(subscriber.cursor),
        fence: subscriber.fence,
        hostNow
      },
      { currentWork: work }
    )
  }
}

export function republishBackgroundTaskFrames(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'hooks'>,
  subscribers: Iterable<Subscriber>,
  sessionId: string,
  fence: number,
  hostNow: number
): void {
  const state = port.hooks.readBackgroundTasks?.(sessionId)
  if (state === undefined) {
    return
  }
  const fingerprint = backgroundTaskFingerprint(state)
  for (const subscriber of subscribers) {
    if (subscriber.backgroundTasks === fingerprint) {
      continue
    }
    port.emit(subscriber, {
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
