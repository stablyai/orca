import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import { journalReceiptsAfter } from '../../../agent-session-journal/journal-status-receipt-progress'
import { agentSessionPublishedWorkFields } from '../../observations/agent-session-published-work'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './agent-session-subscribe-input'

/** A warm, structurally caught-up subscriber needs only the committed changed records. */
export async function deliverReceiptSuffix(
  port: SubscriberDeliveryPort,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number
): Promise<boolean> {
  if (
    !subscriber.readsProviderReceipts ||
    subscriber.projectJournalEvent ||
    subscriber.workView === undefined
  ) {
    return false
  }
  if (!port.isActive(subscriber)) {
    return true
  }
  const receipts = journalReceiptsAfter(journal, subscriber.cursor)
  const work = receipts && port.hooks.readCachedWork?.(subscriber.sessionId, journal)
  if (!receipts || !work || work.workViewKey() !== subscriber.workView) {
    return false
  }
  const fields = agentSessionPublishedWorkFields(journal, work)
  for (let start = 0; start < receipts.length; start += AGENT_SESSION_HISTORY_MAX_LIMIT) {
    const chunk = receipts.slice(start, start + AGENT_SESSION_HISTORY_MAX_LIMIT)
    const cursor = { epoch: work.cursor.epoch, sequence: chunk.at(-1)!.sequence }
    await port.emit(
      subscriber,
      {
        type: 'batch',
        sessionId: subscriber.sessionId,
        batch: {
          ...emptyAgentSessionBatch(cursor),
          submissions: chunk.map(({ submission }) => work.publishedSubmission(submission))
        },
        fence: subscriber.fence,
        hostNow,
        ...fields
      },
      { receiptsOnly: true }
    )
    if (!port.isActive(subscriber)) {
      break
    }
    subscriber.cursor = cursor
  }
  return true
}
