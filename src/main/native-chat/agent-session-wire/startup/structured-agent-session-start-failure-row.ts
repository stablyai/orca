import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureWords,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import type { JournalLifecycleMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { failedProviderChildStart } from '../host/structured-agent-session-provider-child'
import { structuredAgentSessionEndedChildFailure } from '../termination/structured-agent-session-ended-child-failure'

/** A failed start applies only to the queued message that requested it. */
export async function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession,
  oldest: AgentJournalSubmission
): Promise<{ startKey: string | null; cause: StructuredAgentSessionStartFailureCause } | null> {
  const ended = failedProviderChildStart(session)
  if (
    !ended ||
    ended.startedFor !== oldest.clientMessageId ||
    oldest.acceptedSequence === undefined ||
    ended.endedAt.sequence < oldest.acceptedSequence
  ) {
    return null
  }
  if (ended.endedAt.epoch !== (await session.journal.reads.cursor()).epoch) {
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
  const entry = clientMessageId === null ? undefined : session.journal.submission(clientMessageId)
  const selected = entry && isQueuedAgentJournalSubmission(entry) ? entry : undefined
  const startKey = failure.startKey ?? clientMessageId
  const rejection = { reason: failure.reason, rejection: failure.rejection }
  if (startKey === null || (clientMessageId !== null && !selected)) {
    return
  }
  await session.journal.appendLifecycleBatch({
    settlementId: `start-failure:${startKey}`,
    keepFailedStart: true,
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

export async function acceptedNoLaterThan(
  journal: Pick<StructuredAgentSessionHostSession['journal'], 'reads'>,
  cursor: AgentJournalCursor
): Promise<(submission: AgentJournalSubmission) => boolean> {
  const current = await journal.reads.cursor()
  return (submission) =>
    current.epoch === cursor.epoch &&
    submission.acceptedSequence !== undefined &&
    submission.acceptedSequence <= cursor.sequence
}

export async function oldestQueuedSubmission(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>
): Promise<AgentJournalSubmission | undefined> {
  return (await session.journal.reads.input({ kind: 'first-queued' })).submission
}

export async function recordStructuredAgentSessionDeliveryFailure(
  session: Pick<StructuredAgentSessionHostSession, 'journal'> & { fence: number },
  failure: NonNullable<Awaited<ReturnType<typeof startThatFailedWhileQueued>>>,
  context: AgentSessionFailureWordsContext,
  clientMessageId: string | null
): Promise<void> {
  await recordStructuredAgentSessionStartFailure(
    session,
    { startKey: failure.startKey, ...structuredAgentSessionStartFailure(failure.cause, context) },
    clientMessageId
  )
}

export async function failedStructuredAgentSessionInputContinuation(
  journal: StructuredAgentSessionHostSession['journal'],
  context: AgentSessionFailureWordsContext,
  cause: StructuredAgentSessionStartFailureCause,
  fence: number,
  startKey: string
) {
  const words = structuredAgentSessionStartFailure(cause, context)
  if (!('failure' in cause && cause.failure.kind === 'cancelled')) {
    await journal.appendLifecycleBatch({
      settlementId: `start-failure:${startKey}`,
      fence,
      recovered: true,
      mutations: [structuredAgentSessionStartFailureRow(startKey, words)]
    })
  }
  return { kind: 'failed' as const, fence, outcome: { state: 'rejected' as const, ...words } }
}
