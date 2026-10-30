import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
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
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { failedProviderChildStart } from './structured-agent-session-provider-child'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'

/** A failed start applies only to the queued message that requested it. */
export function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession,
  oldest: AgentJournalSubmission
): { startKey: string | null; cause: StructuredAgentSessionStartFailureCause } | null {
  const ended = failedProviderChildStart(session)
  if (
    !ended ||
    ended.startedFor !== oldest.clientMessageId ||
    oldest.acceptedSequence === undefined ||
    ended.endedAt.epoch !== session.journal.cursor().epoch ||
    ended.endedAt.sequence < oldest.acceptedSequence
  ) {
    return null
  }
  const cause = structuredAgentSessionEndedChildFailure(ended)
  return cause ? { startKey: ended.generation, cause } : null
}

export function refusedStructuredAgentSessionStart(
  record: AgentSessionRecord | null,
  {
    refusal,
    diagnostic,
    argumentProblem,
    expired,
    failure,
    startKey = null
  }: Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
): { startKey: string | null; cause: StructuredAgentSessionStartFailureCause } {
  if (expired) {
    return { startKey, cause: { failure: agentSessionFailureFact('hostStopped') } }
  }
  if (failure) {
    return { startKey, cause: { failure } }
  }
  return {
    startKey,
    cause: {
      refusal,
      ...(diagnostic ? { diagnostic } : {}),
      ...(argumentProblem ? { argumentProblem } : {}),
      ...(record?.providerHandleChain.length === 0 ? { newSession: true as const } : {})
    }
  }
}

export type StructuredAgentSessionStartFailure = StructuredAgentSessionStartFailureWords & {
  startKey: string | null
}

/** Deduplicate durable failure by child generation, or oldest opening message if no child published. */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: StructuredAgentSessionStartFailureWords
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

/** Preserve original rejection wording; later exit reports must not revise terminal startup failures. */
export function hasStructuredAgentSessionStartFailureRow(
  items: readonly { itemId: string }[],
  startKey: string
): boolean {
  const itemId = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity(startKey))
  return items.some((item) => item.itemId === itemId)
}

/**
 * A failed start settles its selected message, or only its row when no message requested it.
 */
export async function recordStructuredAgentSessionStartFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: StructuredAgentSessionStartFailure,
  clientMessageId: string | null
): Promise<void> {
  const selected = session.journal
    .submissions()
    .find(
      (entry) => entry.clientMessageId === clientMessageId && isQueuedAgentJournalSubmission(entry)
    )
  const startKey = failure.startKey ?? clientMessageId
  const rejection = { reason: failure.reason, rejection: failure.rejection }
  if (startKey === null || (clientMessageId !== null && !selected)) {
    return
  }
  await session.journal.appendLifecycleBatch({
    settlementId: `start-failure:${startKey}`,
    fence: session.fence,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(startKey, failure)],
    ...(selected
      ? {
          dispatches: [
            {
              clientMessageId: selected.clientMessageId,
              fence: session.fence,
              state: 'rejected' as const,
              recovered: true as const,
              ...rejection
            }
          ]
        }
      : {})
  })
}

export function acceptedNoLaterThan(
  journal: Pick<StructuredAgentSessionHostSession['journal'], 'cursor'>,
  cursor: AgentJournalCursor
): (submission: AgentJournalSubmission) => boolean {
  return (submission) =>
    journal.cursor().epoch === cursor.epoch &&
    submission.acceptedSequence !== undefined &&
    submission.acceptedSequence <= cursor.sequence
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

export async function recordStructuredAgentSessionDeliveryFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: NonNullable<ReturnType<typeof startThatFailedWhileQueued>>,
  context: AgentSessionFailureWordsContext,
  clientMessageId: string | null
): Promise<void> {
  await recordStructuredAgentSessionStartFailure(
    session,
    { startKey: failure.startKey, ...structuredAgentSessionStartFailure(failure.cause, context) },
    clientMessageId
  )
}
