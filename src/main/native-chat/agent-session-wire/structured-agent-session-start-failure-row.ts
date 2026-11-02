import { failedProviderChildStart } from './structured-agent-session-provider-child'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type {
  StructuredAgentSessionStartFailureWords,
  StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'

export function refusedStructuredAgentSessionStart(
  record: AgentSessionRecord | null,
  {
    refusal,
    diagnostic,
    argumentProblem,
    expired
  }: Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
): { startKey: null; cause: StructuredAgentSessionStartFailureCause } {
  if (expired) {
    return { startKey: null, cause: { failure: agentSessionFailureFact('hostStopped') } }
  }
  return {
    startKey: null,
    cause: {
      refusal,
      ...(diagnostic ? { diagnostic } : {}),
      ...(argumentProblem ? { argumentProblem } : {}),
      ...(record?.providerHandleChain.length === 0 ? { newSession: true as const } : {})
    }
  }
}

/** A start that failed, keyed like its row, in the words `structuredAgentSessionStartFailure` gave. */
export type StructuredAgentSessionStartFailure = StructuredAgentSessionStartFailureWords & {
  startKey: string | null
}

/**
 * The one row a start that failed leaves in the chat, whoever saw it fail: an error row, so the
 * reason outlives any error strip. Keyed by the start — the child's generation, or the oldest
 * message it was for when no child was ever published — so a second report of the same failure
 * lands on the same row instead of adding one.
 */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: StructuredAgentSessionStartFailureWords
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    // The row repeats the sentence the start's rejected messages carry.
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    // A start that failed opened no turn.
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

/** Whether the start's row is already written. Its words are the ones its rejected messages carry,
 *  and rejected is terminal, so the exit's later report of the same start must not reword it. */
export function hasStructuredAgentSessionStartFailureRow(
  items: readonly { itemId: string }[],
  startKey: string
): boolean {
  const itemId = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey))
  return items.some((item) => item.itemId === itemId)
}

/**
 * A start the delivery loop needed and did not get: every queued message rejected with the same
 * words, then the start's row. A failed owned open also records its cause before any message.
 */
export async function recordStructuredAgentSessionStartFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: StructuredAgentSessionStartFailure
): Promise<void> {
  const oldest = oldestQueuedSubmission(session)
  const startKey = failure.startKey ?? oldest?.clientMessageId
  if (startKey === undefined) {
    return
  }
  await session.journal.appendLifecycleBatch({
    settlementId: `start-failure:${startKey}`,
    fence: session.fence,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(startKey, failure)],
    ...(oldest ? { rejectsQueued: { reason: failure.reason, rejection: failure.rejection } } : {})
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

/** A start that died while this message waited on it — a view's, say — is the message's failed
 *  start: settled with it, under its key, rather than started again into the same failure. */
export function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession,
  oldest: NonNullable<ReturnType<typeof oldestQueuedSubmission>>
): { startKey: string | null; cause: StructuredAgentSessionStartFailureCause } | null {
  const ended = failedProviderChildStart(session)
  if (
    !ended ||
    oldest.acceptedSequence === undefined ||
    ended.endedAt.epoch !== session.journal.cursor().epoch ||
    ended.endedAt.sequence < oldest.acceptedSequence
  ) {
    return null
  }
  const cause = structuredAgentSessionEndedChildFailure(ended)
  return cause ? { startKey: ended.generation, cause } : null
}
