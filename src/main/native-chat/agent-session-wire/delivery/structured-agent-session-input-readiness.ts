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
import type { StructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'

/** Queue conversion and provider handoff use the same live child acceptance rule. */
export function structuredAgentSessionChildAcceptsInput(input: {
  child: StructuredAgentSessionProviderChild | null | undefined
  current: boolean
  stopping: boolean
  work: StructuredAgentSessionCurrentWork | null
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
export function structuredAutomaticMailWaits(
  journal: AgentSessionJournal,
  submission: AgentJournalSubmission,
  work: StructuredAgentSessionCurrentWork | null
): boolean {
  if (
    submission.origin !== 'host' ||
    submission.queuedMessageId === undefined ||
    journal.queuedMessages.get(submission.queuedMessageId)?.consumedAs !==
      submission.clientMessageId
  ) {
    return false
  }
  const body = journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
  if (body?.kind !== 'message' || !orchestrationMailNotice(body.from)) {
    return false
  }
  const cards = journal.inputOrder.cards
  cards.ensure(journal.queuedMessages.inputState())
  return Boolean(
    cards.failureHolds() ||
    (work &&
      work.attentionPrompts().length > 0 &&
      !pendingPromptsAllUnanswerableHere(work.attentionPrompts()))
  )
}

/** Rechecked on the host lane before preparation and the synchronous provider enqueue. */
export function assertStructuredAgentSessionInputReady(input: {
  deps: StructuredAgentSessionDeliveryLoopDeps
  sessionId: string
  session: StructuredAgentSessionHostSession
  binding: StructuredAgentSessionProviderChild
  next: AgentJournalSubmission
  disposed: boolean
  signal?: AbortSignal
}): void {
  const { deps, sessionId, session, binding, next, disposed, signal } = input
  const current = deps.sessions.get(sessionId) === session && session.child === binding
  if (
    signal?.aborted ||
    disposed ||
    deps.sessions.get(sessionId) !== session ||
    session.journal.submission(next.clientMessageId)?.dispatchState !== 'pending' ||
    !structuredAgentSessionChildAcceptsInput({
      child: binding,
      current,
      stopping: deps.stopping(sessionId),
      work: deps.currentWork(sessionId)
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
        deps.failureTextContext(sessionId)
      )
    })
  }
  if (structuredAutomaticMailWaits(session.journal, next, deps.currentWork(sessionId))) {
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('notDelivered', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    })
  }
}
