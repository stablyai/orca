// Replace outgrown launch construction before user input; work the process owns keeps its child.

import {
  agentSessionFailureFact,
  readWholeAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'

export type StructuredAgentSessionChildTransition =
  | AgentSessionRefusalReference
  | ((providerTurn: () => string | null) => boolean)
  | void

export async function rejectBlockedStructuredAgentSessionTransition(
  deps: {
    retireOutgrownChild: (
      sessionId: string,
      next: AgentJournalSubmission
    ) => Promise<StructuredAgentSessionChildTransition>
    sessions: ReadonlyMap<string, Pick<StructuredAgentSessionHostSession, 'journal'>>
    conversationFence: (sessionId: string) => number
    failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  },
  sessionId: string,
  next: AgentJournalSubmission
): Promise<boolean | ((providerTurn: () => string | null) => boolean)> {
  const refusal = await deps.retireOutgrownChild(sessionId, next)
  if (!refusal || typeof refusal === 'function') {
    return refusal ?? false
  }
  await deps.sessions.get(sessionId)?.journal.resolveDispatch({
    clientMessageId: next.clientMessageId,
    state: 'rejected',
    fence: deps.conversationFence(sessionId),
    ...agentSessionFailureWords(agentSessionFailureFact('restartFailed', { refusal }), {
      ...deps.failureTextContext(sessionId),
      surface: 'rejection'
    })
  })
  return true
}

type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<
    AgentSessionJournal,
    'visitItemsWithLinkage' | 'itemFence' | 'newestTurn' | 'itemBody'
  > & {
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** Scope sign-out evidence to this child’s fence so replacement children do not inherit it. */
export function structuredAgentSessionChildReportedSignedOut(
  session: OutgrownChildReading
): boolean {
  const { child, journal } = session
  if (!child || child.phase === 'starting' || child.close) {
    return false
  }
  if (
    journal
      .submissions()
      .some(
        (submission) =>
          submission.dispatchState === 'rejected' &&
          submission.fence === child.fence &&
          signedOut(submission.rejection)
      )
  ) {
    return true
  }
  // A subagent’s sign-in failure says nothing about the parent.
  let found = false
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    found ||=
      body.kind === 'status' &&
      isRootAgentJournalItem(attribution) &&
      signedOut(body.failure) &&
      journal.itemFence(itemId) === child.fence
  })
  return found
}

/** Wait for the lead’s wake-up after child completion; unlike idle sweep, immediate restart has no window. */
function owesWakeUp(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
  const ended = journal.newestTurn()?.completedAt
  return (childWork ?? []).some(
    (work) => work.settledAt !== undefined && (ended === undefined || work.settledAt > ended)
  )
}

/** Compare the actual launch mode so replacement cannot loop. */
async function launchedWithOtherPermissionMode(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentChatPermissionChoice | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.permissionMode || !current) {
    return false
  }
  const mode = await current()
  return mode !== null && mode !== child.permissionMode
}

/** Retire under serialization only when no work is owed; failed Stop leaves a close for startup to join. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: {
    /** Read records only for child endings the lead has not answered. */
    work: StructuredAgentSessionChildWorkReads & {
      childWork: () => readonly AgentChildWorkView[] | undefined
    }
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>
    turnScopedSteering?: boolean
    next?: AgentJournalSubmission
    requiresModelTransitionRestart?: (next: AgentJournalSubmission) => boolean
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<StructuredAgentSessionChildTransition> {
  if (!session) {
    return
  }
  const body =
    deps.next && session.journal.itemBody(agentJournalSubmissionKey(deps.next.clientMessageId))
  const mail = body?.kind === 'message' && body.from?.orchestration?.message === 'mail-notice'
  const child = session.child
  const turnId =
    deps.turnScopedSteering &&
    child?.phase === 'ready' &&
    !child.close &&
    body?.kind === 'message' &&
    !body.command &&
    !mail &&
    deps.next?.queuedMessageId === undefined
      ? deps.work.currentWork()?.activeTurnId()
      : null
  const steer =
    turnId && child
      ? (providerTurn: () => string | null) =>
          session.child === child &&
          !child.close &&
          deps.work.currentWork()?.activeTurnId() === turnId &&
          providerTurn() === turnId
      : undefined
  const keepOptions = mail || steer !== undefined
  const otherReason =
    structuredAgentSessionChildReportedSignedOut(session) ||
    (!keepOptions && (await launchedWithOtherPermissionMode(session.child, deps.launchPermission)))
  const modelTransition =
    !keepOptions && deps.next && deps.requiresModelTransitionRestart?.(deps.next) === true
  if (!otherReason && !modelTransition) {
    return steer
  }
  const open = structuredAgentSessionChildHasOpenWork(
    modelTransition && !otherReason ? { ...deps.work, hasOpenDispatch: () => false } : deps.work
  )
  if (open && !modelTransition) {
    return steer
  }
  // Wake debt is derived only where it decides: keeping an idle child, or why a model change waits.
  const background =
    (open && deps.work.childWorkOpen()) || owesWakeUp(session.journal, deps.work.childWork())
  if (open || background) {
    return modelTransition
      ? {
          code: 'agent_session_operation_invalid',
          details: { reason: background ? 'backgroundTasksRunning' : 'messagesUnsettled' }
        }
      : undefined
  }
  if (!session.child || session.child.phase === 'starting' || session.child.close) {
    return
  }
  await deps.stopAgent(sessionId).catch((error: unknown) =>
    deps.logger.warn('replacing an outgrown agent failed', {
      scope: 'outgrown-child',
      sessionId,
      error
    })
  )
}
