import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionTurnActivity
} from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { subscriberHistoryReader } from '../history/agent-session-bounded-frames'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from '../../observations/agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import type { Subscriber } from './agent-session-subscribe-input'
import { journalReceiptOverlay } from '../../../agent-session-journal/journal-status-receipt-progress'
import { restatedQueuedImageSubmission } from '../history/agent-session-queued-image-reader'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'

/** Restatements cannot share a history page's already allocated byte budget. */
export async function refreshPublishedWork(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork | undefined,
  current: () => boolean,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null },
  queue?: { value: QueuePublication | undefined }
): Promise<void> {
  if (!work || subscriber.stopped?.aborted || !port.isActive(subscriber)) {
    return
  }
  const view = work.workViewKey()
  const fields = agentSessionPublishedWorkFields(journal, work)
  const { budgetBytes } = subscriberHistoryReader(subscriber)
  const withReceipt = journalReceiptOverlay(journal, work.cursor)
  const checkCurrent = () => {
    if (!current()) {
      throw new SubscriberFrameSuperseded()
    }
  }
  let pending: AgentJournalSubmission[] = []
  let bytes = 0
  const emit = async (): Promise<void> => {
    checkCurrent()
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: { ...emptyAgentSessionBatch(subscriber.cursor), submissions: pending },
        fence: subscriber.fence,
        ...fields,
        ...shared
      },
      {
        currentWork: work,
        journal,
        current: checkCurrent,
        restatement: true,
        queuePublication: queue
      }
    )
    pending = []
    bytes = 0
  }
  const cards = subscriber.projectJournalEvent
    ? (queue?.value ?? subscriber.queuePublication)?.queuedMessages
    : undefined
  checkCurrent()
  for (const record of work.restatedSubmissions()) {
    const stamped = withReceipt(record)
    const submission = cards ? restatedQueuedImageSubmission(cards, stamped) : stamped
    const submissionBytes = Buffer.byteLength(JSON.stringify(submission), 'utf8') + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + submissionBytes > budgetBytes)
    ) {
      await emit()
      if (!port.isActive(subscriber)) {
        return
      }
      checkCurrent()
    }
    pending.push(submission)
    bytes += submissionBytes
  }
  // Empty work still owes its fields when ownership changed without a journal row.
  await emit()
  if (port.isActive(subscriber)) {
    checkCurrent()
    subscriber.workView = view
  }
}
