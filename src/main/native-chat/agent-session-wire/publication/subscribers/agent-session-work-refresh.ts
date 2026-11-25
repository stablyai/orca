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
import type { Subscriber } from './agent-session-subscribe-input'
import { SubscriberFrameSuperseded } from './agent-session-subscriber-frame-capture'

/** Restatements cannot share a history page's already allocated byte budget. */
export async function refreshPublishedWork(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork | undefined,
  current: () => boolean,
  shared: { hostNow: number; activity?: AgentSessionTurnActivity | null }
): Promise<void> {
  if (!work || !port.isActive(subscriber)) {
    return
  }
  const view = work.workViewKey()
  const fields = agentSessionPublishedWorkFields(journal, work)
  const { budgetBytes } = subscriberHistoryReader(subscriber)
  const ids = [...work.restatedSubmissionIds()]
  // Off-page restatements need the same authoritative attempt metadata as the page.
  const records = ids.length
    ? await journal.readInOrder(async (reads) => {
        if (!current()) {
          throw new SubscriberFrameSuperseded()
        }
        const submissions: AgentJournalSubmission[] = []
        for (const id of ids) {
          const submission = await reads.submission(id)
          if (submission) {
            submissions.push(work.publishedSubmission(submission))
          }
        }
        if (!current()) {
          throw new SubscriberFrameSuperseded()
        }
        return submissions
      })
    : []
  let pending: AgentJournalSubmission[] = []
  let bytes = 0
  const emit = async (): Promise<void> => {
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
      { currentWork: work, journal }
    )
    pending = []
    bytes = 0
  }
  for (const submission of records) {
    const submissionBytes = Buffer.byteLength(JSON.stringify(submission), 'utf8') + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT || bytes + submissionBytes > budgetBytes)
    ) {
      await emit()
      if (!port.isActive(subscriber)) {
        return
      }
    }
    pending.push(submission)
    bytes += submissionBytes
  }
  // Empty work still owes its fields when ownership changed without a journal row.
  await emit()
  if (port.isActive(subscriber)) {
    subscriber.workView = view
  }
}
