import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { boundJournalStatusText } from '../agent-session-journal/journal-prompt-body-bounds'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionStartFailureWords } from './structured-agent-session-failure-text'

/** A start that failed, keyed like its row, in the words `structuredAgentSessionStartFailure` gave. */
export type StructuredAgentSessionStartFailure = StructuredAgentSessionStartFailureWords & {
  startKey: string | null
}

/**
 * The one row a start that failed leaves in the chat, whoever saw it fail: an error row, so the
 * reason outlives any error strip. Keyed by the start — the child's generation, or the oldest
 * message it was for when no child was ever published — so a second report of the same failure
 * revises the row instead of adding one.
 */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: StructuredAgentSessionStartFailureWords
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: `start-failure:${startKey}` },
    body: {
      kind: 'status',
      text: boundJournalStatusText(words.text),
      tone: 'error',
      failure: words.failure
    }
  }
}

/**
 * A start the delivery loop needed and did not get: the start's row, and every queued message
 * rejected with the same words. Writes nothing when nothing is still queued: a start whose
 * messages Stop withdrew did not fail anyone.
 */
export async function recordStructuredAgentSessionStartFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: StructuredAgentSessionStartFailure
): Promise<void> {
  const oldest = oldestQueuedSubmission(session)
  if (!oldest) {
    return
  }
  const startKey = failure.startKey ?? oldest.clientMessageId
  await session.journal.appendLifecycleBatch({
    settlementId: `start-failure:${startKey}`,
    fence: session.fence,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(startKey, failure)]
  })
  await session.journal.rejectQueuedSubmissions(session.fence, {
    reason: failure.text,
    rejection: failure.failure
  })
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
