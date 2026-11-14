// Replace an outgrown child only when its provider needs acquisition to apply the current choice.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from '../termination/structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<AgentSessionJournal, 'reads'>
}

/** Wait for the lead’s wake-up after child completion; unlike idle sweep, immediate restart has no window. */
function owesWakeUp(
  ended: number | undefined,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
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
  body: AgentJournalMessageItem | null,
  next: AgentJournalSubmission | undefined,
  requiresModelTransitionRestart: ((next: AgentJournalSubmission) => boolean) | undefined
): boolean {
  if (!next || !requiresModelTransitionRestart) {
    return false
  }
  return (
    body !== null &&
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
  if (!session?.child) {
    return
  }
  const { child } = session
  const facts = await session.journal.reads.outgrownChild({
    fence: child.fence,
    ...(deps.next ? { nextClientMessageId: deps.next.clientMessageId } : {})
  })
  if (
    !(
      (child.phase !== 'starting' && !child.close && facts.signedOut) ||
      picksNewLaunchModel(facts.nextMessage, deps.next, deps.requiresModelTransitionRestart) ||
      (await launchedWithOtherPermissionMode(
        session.child,
        deps.launchPermission,
        deps.permissionRequiresAcquisition
      )) ||
      (await launchedUnderOtherAccount(session.child, deps.launchAccountHome))
    ) ||
    structuredAgentSessionChildHasOpenWork(deps.work, await deps.work.currentWork()) ||
    owesWakeUp(facts.newestTurnCompletedAt, deps.work.childWork())
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

export async function structuredAgentSessionChildOwesWork(
  work: StructuredAgentSessionChildWorkReads & {
    childWork: () => readonly AgentChildWorkView[] | undefined
  }
): Promise<boolean> {
  const current = await work.currentWork()
  return (
    structuredAgentSessionChildHasOpenWork(work, current) ||
    owesWakeUp(current?.newestTurnCompletedAt, work.childWork())
  )
}
