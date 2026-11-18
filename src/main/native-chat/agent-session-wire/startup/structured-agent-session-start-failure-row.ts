import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureWords,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { journalStartFailureRow } from '../../agent-session-journal/writing/journal-start-failure-settlement'
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

export { journalStartFailureRow as structuredAgentSessionStartFailureRow }

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
  session: {
    journal: Pick<StructuredAgentSessionHostSession['journal'], 'settleStartFailure'>
    fence: number
  },
  failure: StructuredAgentSessionStartFailure,
  clientMessageId: string | null
): Promise<void> {
  const startKey = failure.startKey ?? clientMessageId
  if (startKey === null) {
    return
  }
  await session.journal.settleStartFailure({
    startKey,
    clientMessageId,
    fence: session.fence,
    reason: failure.reason,
    rejection: failure.rejection
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
      mutations: [journalStartFailureRow(startKey, words)]
    })
  }
  return { kind: 'failed' as const, fence, outcome: { state: 'rejected' as const, ...words } }
}
