import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import {
  agentSessionPublishedWorkFieldSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'

/** Restatements cannot share a history page's already allocated byte budget. */
export function refreshPublishedWork(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'emitSteps' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork | undefined,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null }
): void {
  finishJournalSteps(refreshPublishedWorkSteps(port, subscriber, journal, work, shared))
}

export function* refreshPublishedWorkSteps(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'emitSteps' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork | undefined,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null }
): Generator<void> {
  if (!work || !port.isActive(subscriber)) {
    return
  }
  const view = work.workViewKey()
  const fields = yield* agentSessionPublishedWorkFieldSteps(journal, work)
  const { budgetBytes } = subscriberHistoryReader(subscriber)
  let pending: AgentJournalSubmission[] = []
  let bytes = 0
  const emit = function* (): Generator<void, boolean> {
    const args: Parameters<SubscriberDeliveryPort['emit']> = [
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), submissions: pending },
        fence: subscriber.fence,
        ...fields,
        ...shared
      },
      { currentWork: work, journal }
    ]
    if (port.emitSteps) {
      if ((yield* port.emitSteps(...args)) === false) {
        return false
      }
    } else {
      port.emit(...args)
    }
    pending = []
    bytes = 0
    return true
  }
  for (const submission of work.restatedSubmissions()) {
    yield
    const submissionBytes = Buffer.byteLength(JSON.stringify(submission), 'utf8') + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + submissionBytes > budgetBytes)
    ) {
      if (!(yield* emit())) {
        return
      }
      if (!port.isActive(subscriber)) {
        return
      }
    }
    pending.push(submission)
    bytes += submissionBytes
  }
  // Empty work still owes its fields when ownership changed without a journal row.
  if (!(yield* emit())) {
    return
  }
  if (port.isActive(subscriber)) {
    subscriber.workView = view
  }
}
