import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { boundJournalStatusText } from '../agent-session-journal/journal-prompt-body-bounds'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

/**
 * A start the delivery loop needed and did not get: one error row in the chat, so the reason
 * outlives any error strip, and every queued message rejected with the same words. Keyed by the
 * oldest message it failed, so a replayed failure adds no second row. Writes nothing when nothing
 * is still queued: a start whose messages Stop withdrew did not fail anyone.
 */
export async function recordStructuredAgentSessionStartFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  text: string
): Promise<void> {
  const oldest = oldestQueuedSubmission(session)
  if (!oldest) {
    return
  }
  const settlementId = `start-failure:${oldest.clientMessageId}`
  await session.journal.appendLifecycleBatch({
    settlementId,
    fence: session.fence,
    recovered: true,
    mutations: [
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: settlementId },
        body: { kind: 'status', text: boundJournalStatusText(text), tone: 'error' }
      }
    ]
  })
  await session.journal.rejectQueuedSubmissions(session.fence, text)
}

export function oldestQueuedSubmission(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>
): ReturnType<StructuredAgentSessionHostSession['journal']['submissions']>[number] | undefined {
  let oldest: ReturnType<typeof oldestQueuedSubmission>
  for (const submission of session.journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  return oldest
}
