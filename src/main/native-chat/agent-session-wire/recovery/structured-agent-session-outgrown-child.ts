// Replace an outgrown child only when its provider needs acquisition to apply the current choice.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalWorkAnswer } from '../../agent-session-journal/journal-work-read'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
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

type OutgrownChildReading = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'operationalRevision'
> & {
  journal: Pick<AgentSessionJournal, 'reads' | 'cursor' | 'physicalCursor'>
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

/** The bot's tools changed since this child launched; a start reads them again. */
async function launchedWithOtherTools(
  child: OutgrownChildReading['child'],
  changed: (() => Promise<boolean>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !changed) {
    return false
  }
  return await changed().catch(() => false)
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
    launchToolsChanged?: () => Promise<boolean>
    /** The send about to be handed over; a new model pick may need the requested approval mode. */
    next?: AgentJournalSubmission
    requiresModelTransitionRestart?: (next: AgentJournalSubmission) => boolean
    permissionRequiresAcquisition?: (mode: AgentChatPermissionChoice) => boolean
    /** `onlyIf` is decided at the instant the child would be marked closing. */
    stopAgent: (sessionId: string, onlyIf?: () => boolean) => Promise<void>
    logger: StructuredAgentSessionLogger
    /** An account switch, with no send to hand over: only the account the child launched under
     *  outgrows it. `committed` is false once the selection it was told of is pending or replaced;
     *  `currentWorkOnce` is null when the journal moved while it read. */
    accountSwitch?: {
      committed: () => boolean
      currentWorkOnce: () => Promise<JournalWorkAnswer<'child-work'> | null>
    }
  }
): Promise<void> {
  if (!session?.child) {
    return
  }
  const { child } = session
  const { accountSwitch } = deps
  if (accountSwitch) {
    // The account first: its lookup can wait on files while the provider opens work.
    if (!(await launchedUnderOtherAccount(child, deps.launchAccountHome))) {
      return
    }
    const { journal } = session
    const cursor = journal.cursor()
    const physical = journal.physicalCursor()
    const revision = session.operationalRevision
    const work = await accountSwitch.currentWorkOnce()
    // Uncertain or owed (a lead's wake-up for a finished background task included): keep it.
    // Child work and held sends change without a journal row, so the stop asks again at the end.
    const owes = (answer: JournalWorkAnswer<'child-work'>) =>
      structuredAgentSessionChildHasOpenWork(deps.work, answer) ||
      owesWakeUp(answer.newestTurnCompletedAt, deps.work.childWork())
    if (!work || owes(work)) {
      return
    }
    // Anything written since that read, owed since, or the selection moving on keeps the agent.
    await stopOutgrown(
      sessionId,
      deps,
      () =>
        session.child === child &&
        !child.close &&
        sameJournalCursor(cursor, journal.cursor()) &&
        sameJournalCursor(physical, journal.physicalCursor()) &&
        revision === session.operationalRevision &&
        !owes(work) &&
        accountSwitch.committed()
    )
    return
  }
  const facts = await session.journal.reads.outgrownChild({
    fence: child.fence,
    ...(deps.next ? { nextClientMessageId: deps.next.clientMessageId } : {})
  })
  const reason =
    child.phase !== 'starting' && !child.close && facts.signedOut
      ? 'signed-out'
      : picksNewLaunchModel(facts.nextMessage, deps.next, deps.requiresModelTransitionRestart)
        ? 'model'
        : (await launchedWithOtherPermissionMode(
              session.child,
              deps.launchPermission,
              deps.permissionRequiresAcquisition
            ))
          ? 'permission-mode'
          : (await launchedUnderOtherAccount(session.child, deps.launchAccountHome))
            ? 'account'
            : (await launchedWithOtherTools(session.child, deps.launchToolsChanged))
              ? 'tools'
              : null
  if (
    reason === null ||
    structuredAgentSessionChildHasOpenWork(deps.work, await deps.work.currentWork()) ||
    owesWakeUp(facts.newestTurnCompletedAt, deps.work.childWork())
  ) {
    return
  }
  // Says why, so an agent replaced instead of changed live can be traced.
  deps.logger.warn('replacing an outgrown agent', { scope: 'outgrown-child', sessionId, reason })
  await stopOutgrown(sessionId, deps)
}

function stopOutgrown(
  sessionId: string,
  deps: Pick<
    Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2],
    'stopAgent' | 'logger'
  >,
  onlyIf?: () => boolean
): Promise<void> {
  return deps.stopAgent(sessionId, onlyIf).catch((error: unknown) =>
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
