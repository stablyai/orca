import type {
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import { structuredAgentSessionStartFailure } from '../startup/structured-agent-session-failure-text'
import { structuredAgentSessionEndedChildFailure } from '../termination/structured-agent-session-ended-child-failure'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'

/** Queue conversion and provider handoff use the same live child acceptance rule. */
export function structuredAgentSessionChildAcceptsInput(input: {
  child: StructuredAgentSessionProviderChild | null | undefined
  current: boolean
  stopping: boolean
  work: Pick<StructuredAgentSessionObservedWork, 'activeTurnId'> | null
}): boolean {
  return Boolean(
    input.current &&
    input.child?.phase === 'ready' &&
    !input.child.close &&
    !input.stopping &&
    !(input.work && structuredAgentSessionCommandRunning(input.work))
  )
}

/** A consumed automatic card still obeys live pauses until the provider owns its input. */
export async function structuredAutomaticMailWaits(
  journal: AgentSessionJournal,
  submission: AgentJournalSubmission,
  work: StructuredAgentSessionObservedWork | null
): Promise<boolean> {
  if (
    submission.origin !== 'host' ||
    submission.queuedMessageId === undefined ||
    (await journal.queuedMessages.get(submission.queuedMessageId))?.consumedAs !==
      submission.clientMessageId
  ) {
    return false
  }
  const body = await journal.reads.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
  if (body?.kind !== 'message' || !orchestrationMailNotice(body.from)) {
    return false
  }
  return Boolean(
    (await journal.queuedMessages.failureHolds()) ||
    (work?.hasActionablePrompt() && !pendingPromptsAllUnanswerableHere(work.actionablePrompts()))
  )
}

/** Rechecked on the host lane before preparation and the synchronous provider enqueue. */
export async function assertStructuredAgentSessionInputReady(input: {
  deps: StructuredAgentSessionDeliveryLoopDeps
  sessionId: string
  session: StructuredAgentSessionHostSession
  binding: StructuredAgentSessionProviderChild
  next: AgentJournalSubmission
  disposed: boolean
  signal?: AbortSignal
}): Promise<void> {
  const { deps, sessionId, session, binding, next, disposed, signal } = input
  const work = await deps.currentWork(sessionId)
  const waits = await structuredAutomaticMailWaits(session.journal, next, work)
  const stopping = await deps.stopping(sessionId)
  const current = deps.sessions.get(sessionId) === session && session.child === binding
  if (
    signal?.aborted ||
    disposed ||
    deps.sessions.get(sessionId) !== session ||
    !structuredAgentSessionChildAcceptsInput({
      child: binding,
      current,
      stopping,
      work
    })
  ) {
    const ended = session.lastEndedChild
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...structuredAgentSessionStartFailure(
        (ended && sameProviderChild(ended, binding)
          ? structuredAgentSessionEndedChildFailure(ended)
          : null) ?? {
          failure: agentSessionFailureFact('cancelled', { neverReachedAgent: true })
        },
        await deps.failureTextContext(sessionId)
      )
    })
  }
  if (waits) {
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('notDelivered', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    })
  }
}
