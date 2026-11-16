// Replace an outgrown child only when its provider needs acquisition to apply the current choice.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalWorkAnswer } from '../../agent-session-journal/journal-work-read'
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
 *  answer, so unreadable account evidence replaces nothing. Returns the account a start would use. */
async function launchedUnderOtherAccount(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentSessionAccountHome | null>) | undefined
): Promise<AgentSessionAccountHome | null> {
  if (!child || child.phase === 'starting' || child.close || !child.accountHome || !current) {
    return null
  }
  const home = await current().catch(() => null)
  return home !== null && !agentSessionAccountHomesEqual(home, child.accountHome) ? home : null
}

/** What the old child still owes before it may retire; null when it owes nothing. */
async function owedWork(
  work: OutgrownChildWorkReads,
  ended: (current: JournalWorkAnswer<'child-work'> | null) => number | undefined
): Promise<StructuredAgentSessionAccountTransition['waitsFor'] | null> {
  const current = await work.currentWork()
  if (current?.activeTurn === true) {
    return 'turn'
  }
  if (current?.actionablePrompt === true) {
    return 'prompt'
  }
  if (work.childWorkOpen()) {
    return 'child-work'
  }
  if (work.providerHoldsDispatch()) {
    return 'held-send'
  }
  if (work.hasOpenDispatch()) {
    return 'dispatch'
  }
  return owesWakeUp(ended(current), work.childWork()) ? 'wake-up' : null
}

type OutgrownChildWorkReads = StructuredAgentSessionChildWorkReads & {
  childWork: () => readonly AgentChildWorkView[] | undefined
}

/** A chat whose next start moves it to another account or a fresh login, while its running child
 *  still owes work and so cannot retire yet. Derived each read, never stored. */
export type StructuredAgentSessionAccountTransition = {
  cause: 'account' | 'signed-out'
  waitsFor: 'turn' | 'prompt' | 'child-work' | 'held-send' | 'dispatch' | 'wake-up'
  from: AgentSessionAccountHome | null
  to: AgentSessionAccountHome | null
}

export type StructuredAgentSessionOutgrownChild =
  | { kind: 'current' }
  | { kind: 'retired' }
  /** `transition` is absent when only the launch mode or model changed. */
  | { kind: 'deferred'; transition?: StructuredAgentSessionAccountTransition }

type AccountTransitionDeps = {
  work: OutgrownChildWorkReads
  launchAccountHome?: () => Promise<AgentSessionAccountHome | null>
}

/** The account move a running child defers, read without stopping anything. */
export async function readStructuredAgentSessionAccountTransition(
  session: OutgrownChildReading | undefined,
  deps: AccountTransitionDeps
): Promise<StructuredAgentSessionAccountTransition | null> {
  const child = session?.child
  if (!session || !child || child.phase === 'starting' || child.close) {
    return null
  }
  const to = await launchedUnderOtherAccount(child, deps.launchAccountHome)
  const facts = to ? null : await session.journal.reads.outgrownChild({ fence: child.fence })
  if (!to && !facts?.signedOut) {
    return null
  }
  const waitsFor = await owedWork(deps.work, (current) =>
    facts ? facts.newestTurnCompletedAt : current?.newestTurnCompletedAt
  )
  return waitsFor
    ? { cause: to ? 'account' : 'signed-out', waitsFor, from: child.accountHome ?? null, to }
    : null
}

/** Retire under serialization only when no work is owed; failed Stop leaves a close for startup to join. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: AccountTransitionDeps & {
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>
    /** The send about to be handed over; a new model pick may need the requested approval mode. */
    next?: AgentJournalSubmission
    requiresModelTransitionRestart?: (next: AgentJournalSubmission) => boolean
    permissionRequiresAcquisition?: (mode: AgentChatPermissionChoice) => boolean
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<StructuredAgentSessionOutgrownChild> {
  if (!session?.child) {
    return { kind: 'current' }
  }
  const { child } = session
  const facts = await session.journal.reads.outgrownChild({
    fence: child.fence,
    ...(deps.next ? { nextClientMessageId: deps.next.clientMessageId } : {})
  })
  const signedOut = child.phase !== 'starting' && !child.close && facts.signedOut
  const to = signedOut ? null : await launchedUnderOtherAccount(child, deps.launchAccountHome)
  if (
    !signedOut &&
    !to &&
    !picksNewLaunchModel(facts.nextMessage, deps.next, deps.requiresModelTransitionRestart) &&
    !(await launchedWithOtherPermissionMode(
      child,
      deps.launchPermission,
      deps.permissionRequiresAcquisition
    ))
  ) {
    return { kind: 'current' }
  }
  const waitsFor = await owedWork(deps.work, () => facts.newestTurnCompletedAt)
  if (waitsFor) {
    return signedOut || to
      ? {
          kind: 'deferred',
          transition: {
            cause: to ? 'account' : 'signed-out',
            waitsFor,
            from: child.accountHome ?? null,
            to
          }
        }
      : { kind: 'deferred' }
  }
  await deps.stopAgent(sessionId).catch((error: unknown) =>
    deps.logger.warn('replacing an outgrown agent failed', {
      scope: 'outgrown-child',
      sessionId,
      error
    })
  )
  return { kind: 'retired' }
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
