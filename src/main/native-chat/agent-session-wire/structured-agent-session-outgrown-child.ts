// Replace an outgrown child only when its provider needs acquisition to apply the current choice.

import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../shared/agent-session-account-home'

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
  current: (() => Promise<AgentChatPermissionChoice | null>) | undefined,
  requiresAcquisition: ((mode: AgentChatPermissionChoice) => boolean) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.permissionMode || !current) {
    return false
  }
  const mode = await current()
  return (
    mode !== null &&
    (requiresAcquisition ? requiresAcquisition(mode) : mode !== child.permissionMode)
  )
}

/** Orca mail notices are not the user's turn: they keep the running process and its choices. */
function picksNewLaunchModel(
  session: OutgrownChildReading,
  next: AgentJournalSubmission | undefined,
  requiresModelTransitionRestart: ((next: AgentJournalSubmission) => boolean) | undefined
): boolean {
  if (!next || !requiresModelTransitionRestart) {
    return false
  }
  const body = session.journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  return (
    body?.kind === 'message' &&
    body.from?.orchestration?.message !== 'mail-notice' &&
    requiresModelTransitionRestart(next)
  )
}

/** Loop-free while a start launches under the account `current` reads; a read that throws is no
 *  answer, so unreadable account evidence replaces nothing. */
async function launchedUnderOtherAccount(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentSessionAccountHome | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.accountHome || !current) {
    return false
  }
  const home = await current().catch(() => null)
  return home !== null && !agentSessionAccountHomesEqual(home, child.accountHome)
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
    launchAccountHome?: () => Promise<AgentSessionAccountHome | null>
    /** The send about to be handed over; a new model pick may need the requested approval mode. */
    next?: AgentJournalSubmission
    requiresModelTransitionRestart?: (next: AgentJournalSubmission) => boolean
    permissionRequiresAcquisition?: (mode: AgentChatPermissionChoice) => boolean
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !(
      structuredAgentSessionChildReportedSignedOut(session) ||
      picksNewLaunchModel(session, deps.next, deps.requiresModelTransitionRestart) ||
      (await launchedWithOtherPermissionMode(
        session.child,
        deps.launchPermission,
        deps.permissionRequiresAcquisition
      )) ||
      (await launchedUnderOtherAccount(session.child, deps.launchAccountHome))
    ) ||
    structuredAgentSessionChildOwesWork(session.journal, deps.work)
  ) {
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

export function structuredAgentSessionChildOwesWork(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  work: StructuredAgentSessionChildWorkReads & {
    childWork: () => readonly AgentChildWorkView[] | undefined
  }
): boolean {
  return structuredAgentSessionChildHasOpenWork(work) || owesWakeUp(journal, work.childWork())
}
