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

/** Only what the account reading needs of the running child and the journal. */
type AccountTransitionReading = {
  child: Pick<
    NonNullable<StructuredAgentSessionHostSession['child']>,
    'phase' | 'close' | 'fence' | 'accountHome'
  > | null
  journal: { reads: Pick<AgentSessionJournal['reads'], 'outgrownChild'> }
}

/** How long an account move waits for the lead's wake-up after child work ends. A stopped task
 *  or a provider that never wakes the lead would otherwise hold the person's message forever. */
export const STRUCTURED_AGENT_SESSION_ACCOUNT_MOVE_WAKE_UP_MS = 2 * 60_000

/** The newest child completion the lead has not answered. Unlike idle sweep, immediate restart has
 *  no window; an account move (`since`) waits only for recent ones, and never for a stopped task. */
function owedWakeUp(
  ended: number | undefined,
  childWork: readonly AgentChildWorkView[] | undefined,
  since?: number
): number | undefined {
  let newest: number | undefined
  for (const work of childWork ?? []) {
    const settled = work.settledAt
    if (
      settled !== undefined &&
      (ended === undefined || settled > ended) &&
      (since === undefined || (settled >= since && work.outcome !== 'cancelled'))
    ) {
      newest = Math.max(newest ?? settled, settled)
    }
  }
  return newest
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
  child: AccountTransitionReading['child'],
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
  ended: (current: JournalWorkAnswer<'child-work'> | null) => number | undefined,
  wakeUpSince?: number
): Promise<Pick<StructuredAgentSessionAccountTransition, 'waitsFor' | 'wakeUpUntil'> | null> {
  const current = await work.currentWork()
  if (current?.activeTurn === true) {
    return { waitsFor: 'turn' }
  }
  if (current?.actionablePrompt === true) {
    return { waitsFor: 'prompt' }
  }
  if (work.childWorkOpen()) {
    return { waitsFor: 'child-work' }
  }
  if (work.providerHoldsDispatch()) {
    return { waitsFor: 'held-send' }
  }
  if (work.hasOpenDispatch()) {
    return { waitsFor: 'dispatch' }
  }
  const settled = owedWakeUp(ended(current), work.childWork(), wakeUpSince)
  return settled === undefined
    ? null
    : {
        waitsFor: 'wake-up',
        ...(wakeUpSince === undefined
          ? {}
          : { wakeUpUntil: settled + STRUCTURED_AGENT_SESSION_ACCOUNT_MOVE_WAKE_UP_MS })
      }
}

type OutgrownChildWorkReads = StructuredAgentSessionChildWorkReads & {
  childWork: () => readonly AgentChildWorkView[] | undefined
}

/** A chat whose next start moves it to another account or a fresh login, while its running child
 *  still owes work and so cannot retire yet. Kept in memory until an edge can change it. */
export type StructuredAgentSessionAccountTransition = {
  cause: 'account' | 'signed-out'
  waitsFor: 'turn' | 'prompt' | 'child-work' | 'held-send' | 'dispatch' | 'wake-up'
  from: AgentSessionAccountHome | null
  to: AgentSessionAccountHome | null
  /** With `wake-up`: when the move stops waiting for it. */
  wakeUpUntil?: number
}

export type StructuredAgentSessionOutgrownChild =
  | { kind: 'current' }
  | { kind: 'retired' }
  /** `transition` is absent when only the launch mode or model changed. */
  | { kind: 'deferred'; transition?: StructuredAgentSessionAccountTransition }
  /** The person's send is not handed to the old child: it went back to the queue, or keeping it
   *  failed and the next delivery pass tries again. */
  | { kind: 'withheld' }

type AccountTransitionDeps = {
  work: OutgrownChildWorkReads
  launchAccountHome?: () => Promise<AgentSessionAccountHome | null>
  now: () => number
}

type AccountMove = Pick<StructuredAgentSessionAccountTransition, 'cause' | 'from' | 'to'>

/** The account move a running child defers, read without stopping anything. */
export async function readStructuredAgentSessionAccountTransition(
  session: AccountTransitionReading | undefined,
  deps: AccountTransitionDeps & {
    /** A move already read for this child, whose account selection has not changed since. */
    known?: AccountMove
    /** The child's next start stays on its account: nothing it owes needs reading. */
    onNoMove?: () => void
    /** Known from an unchanged selection: only a sign-out can still move it. */
    staysOnAccount?: true
  }
): Promise<StructuredAgentSessionAccountTransition | null> {
  const child = session?.child
  if (!session || !child || child.phase === 'starting' || child.close) {
    return null
  }
  let move = deps.known
  if (!move) {
    const to = deps.staysOnAccount
      ? null
      : await launchedUnderOtherAccount(child, deps.launchAccountHome)
    if (!to && !(await session.journal.reads.outgrownChild({ fence: child.fence })).signedOut) {
      deps.onNoMove?.()
      return null
    }
    move = { cause: to ? 'account' : 'signed-out', from: child.accountHome ?? null, to }
  }
  const owed = await owedWork(
    deps.work,
    (current) => current?.newestTurnCompletedAt,
    deps.now() - STRUCTURED_AGENT_SESSION_ACCOUNT_MOVE_WAKE_UP_MS
  )
  return owed ? { cause: move.cause, ...owed, from: move.from, to: move.to } : null
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
  deps: AccountTransitionDeps & {
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>
    launchToolsChanged?: () => Promise<boolean>
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
    )) &&
    !(await launchedWithOtherTools(child, deps.launchToolsChanged))
  ) {
    return { kind: 'current' }
  }
  const moves = signedOut || to !== null
  const owed = await owedWork(
    deps.work,
    () => facts.newestTurnCompletedAt,
    moves ? deps.now() - STRUCTURED_AGENT_SESSION_ACCOUNT_MOVE_WAKE_UP_MS : undefined
  )
  if (owed) {
    return moves
      ? {
          kind: 'deferred',
          transition: {
            cause: to ? 'account' : 'signed-out',
            ...owed,
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
    owedWakeUp(current?.newestTurnCompletedAt, work.childWork()) !== undefined
  )
}
