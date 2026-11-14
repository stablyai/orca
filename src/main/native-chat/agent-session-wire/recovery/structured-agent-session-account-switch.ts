// Under 'restart-all' a selection in force moves running chats, owed work included, only while the agent holds no send.

import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { structuredAgentSessionHandingOver } from '../delivery/structured-agent-session-handing-over'
import { selectStructuredAgentSessionInput } from '../delivery/structured-agent-session-input-selection'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionChildWorkReads } from '../termination/structured-agent-session-idle-sweep'
import {
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildOwesWork
} from './structured-agent-session-outgrown-child'
import {
  continuationDeps,
  RestartContinuationSupersededError,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost
} from './structured-agent-session-restart-continuation'
import { structuredAgentSessionResumeOperationId } from './structured-agent-session-resume-eligibility'

export type StructuredAgentSessionAccountSwitchStep =
  | { kind: 'kept' }
  | { kind: 'sending'; clientMessageIds: string[]; released: Promise<unknown> }
  | { kind: 'stopped'; continueAfter: number | null }

export type StructuredAgentSessionAccountSwitchRetire = (
  sessionId: string,
  wanted: () => boolean
) => Promise<StructuredAgentSessionAccountSwitchStep>

type AccountSwitchDelivery = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'launchAccountHome' | 'logger'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  clientDelivery: { readStopping: (sessionId: string) => boolean }
  stopOutgrownAgent: (sessionId: string) => Promise<void>
  stopPermissionTransitionChild: (sessionId: string) => Promise<void>
}

type ChildWorkReads = (sessionId: string) => StructuredAgentSessionChildWorkReads & {
  childWork: () => readonly AgentChildWorkView[] | undefined
}

const KEPT = { kind: 'kept' } as const

export async function structuredAgentSessionLaunchAccountIdentity(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'launchAccountHome'>,
  sessionId: string
): Promise<AgentSessionAccountHome | null> {
  const record = deps.store.getRecord(sessionId)
  return record ? ((await deps.launchAccountHome?.(record, 'identity')) ?? null) : null
}

/** A starting or closing child has no settled launch account yet, so it is not known to be on it. */
async function onSelectedAccount(
  deps: AccountSwitchDelivery['deps'],
  session: StructuredAgentSessionHostSession,
  sessionId: string
): Promise<boolean> {
  const { child } = session
  if (!child || child.phase === 'starting' || child.close || !child.accountHome) {
    return false
  }
  const home = await structuredAgentSessionLaunchAccountIdentity(deps, sessionId).catch(() => null)
  return home !== null && agentSessionAccountHomesEqual(home, child.accountHome)
}

/** A queued send pending at the agent's fence was already taken from the queue for that agent. */
function sendInFlight(
  session: StructuredAgentSessionHostSession
): Extract<StructuredAgentSessionAccountSwitchStep, { kind: 'sending' }> | null {
  const handovers = [...structuredAgentSessionHandingOver(session.journal).values()]
  const pending = session.journal
    .pendingSubmissions()
    .filter(
      (submission) =>
        !isQueuedAgentJournalSubmission(submission) || submission.fence === session.child?.fence
    )
    .map((submission) => submission.clientMessageId)
  const clientMessageIds = [...new Set([...pending, ...(session.child?.heldSends?.() ?? [])])]
  if (handovers.length === 0 && clientMessageIds.length === 0) {
    return null
  }
  const released = handovers.flatMap((handover) => handover.input?.finalization.completion ?? [])
  return { kind: 'sending', clientMessageIds, released: Promise.all(released) }
}

/** An accepted send is answered once the turn it was steered into ends, or any turn begun after it. */
function replyOwed({ journal, child }: StructuredAgentSessionHostSession): boolean {
  const accepted = journal
    .submissions()
    .filter(
      (submission) => submission.dispatchState === 'accepted' && submission.fence === child?.fence
    )
  if (accepted.length === 0) {
    return false
  }
  const endedTurns = new Set<string>()
  let newestEndedTurnBegan = -Infinity
  journal.visitItems((itemId, sequence, body) => {
    const turn = readAgentJournalTurn(body)
    if (turn && turn.state !== 'running' && turn.state !== 'unverifiable') {
      endedTurns.add(itemId)
      newestEndedTurnBegan = Math.max(newestEndedTurnBegan, sequence)
    }
  })
  return accepted.some((submission) => {
    const row = journal.item(agentJournalSubmissionKey(submission.clientMessageId))
    if (row?.turnScope?.kind === 'turn') {
      return !endedTurns.has(journal.canonicalItemId(row.turnScope.turnItemId))
    }
    return !row || row.sequence > newestEndedTurnBegan
  })
}

/** Queued sends start the next agent themselves, so only work cut with nothing queued is continued. */
export function retireForAccountSwitch(
  input: AccountSwitchDelivery,
  childWork: ChildWorkReads
): StructuredAgentSessionAccountSwitchRetire {
  return (sessionId, wanted) =>
    input.serialize(sessionId, async () => {
      const declined = input.clientDelivery.readStopping(sessionId) || !wanted()
      const session = declined ? undefined : input.sessions.get(sessionId)
      if (!session?.child || (await onSelectedAccount(input.deps, session, sessionId))) {
        return KEPT
      }
      const sending = sendInFlight(session)
      if (sending) {
        return sending
      }
      const work = childWork(sessionId)
      const owed = structuredAgentSessionChildOwesWork(session.journal, work) || replyOwed(session)
      const stopped = await retireOutgrownStructuredAgentSessionChild(sessionId, session, {
        work,
        evenOwingWork: true,
        launchAccountHome: () => structuredAgentSessionLaunchAccountIdentity(input.deps, sessionId),
        stopAgent: (id) => {
          input.deps.store.requireWritableRecord(id)
          return owed ? input.stopPermissionTransitionChild(id) : input.stopOutgrownAgent(id)
        },
        logger: input.deps.logger
      })
      if (!stopped) {
        return KEPT
      }
      const queued = selectStructuredAgentSessionInput(session.journal).kind !== 'none'
      const continueAfter = owed && !queued ? session.journal.cursor().sequence : null
      return { kind: 'stopped', continueAfter }
    })
}

export async function continueStructuredAgentSessionAfterAccountSwitch(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  sessionId: string,
  continueAfter: number
): Promise<void> {
  const stillWanted = () =>
    host.sessions.get(sessionId)?.journal.inputOrder.acceptedAfter(continueAfter) === false
  try {
    const started = await startStructuredAgentSessionContinuation(
      { ...continuationDeps(host, stillWanted), liftRestartHold: async () => {} },
      sessionId,
      { activity: { state: 'working', prompts: [], tasks: [] }, accountSwitch: true },
      structuredAgentSessionResumeOperationId(host.now())
    )
    if ('verdict' in started) {
      await started.verdict()
    }
  } catch (error) {
    if (!(error instanceof RestartContinuationSupersededError)) {
      throw error
    }
  }
}

type AccountSwitchHost = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger'>
  loadedSessionIds: () => readonly string[]
  waitForSendSettlement: (
    sessionId: string,
    clientMessageId: string,
    options: { budgetMs: number }
  ) => Promise<unknown>
  restartResume: {
    retireForAccountSwitch: StructuredAgentSessionAccountSwitchRetire
    continueAfterAccountSwitch: (sessionId: string, continueAfter: number) => Promise<void>
  }
}

/** Each pass waits for the held sends to settle; sends already waited for and held again mean no progress. */
async function moveChat(
  host: AccountSwitchHost,
  sessionId: string,
  wanted: () => boolean
): Promise<void> {
  const waitedFor = new Set<string>()
  for (;;) {
    const step = await host.restartResume.retireForAccountSwitch(sessionId, wanted)
    if (step.kind === 'stopped' && step.continueAfter !== null) {
      await host.restartResume.continueAfterAccountSwitch(sessionId, step.continueAfter)
    }
    if (step.kind !== 'sending') {
      return
    }
    const sending = step.clientMessageIds.join('\n')
    if (waitedFor.has(sending)) {
      host.deps.logger.warn('a chat kept its account while the agent held a send', {
        scope: 'account-switch',
        sessionId
      })
      return
    }
    waitedFor.add(sending)
    const answered = step.clientMessageIds.map((id) =>
      host
        .waitForSendSettlement(sessionId, id, { budgetMs: MAX_TIMER_DELAY_MS })
        .catch(() => undefined)
    )
    await Promise.all([step.released, ...answered])
  }
}

type ChatMove = { again: boolean; moved: Promise<void> }

const chatMoves = new WeakMap<AccountSwitchHost, Map<string, ChatMove>>()

/** A switch during a chat's pending move asks that move for one more pass instead of waiting beside it. */
function requestChatMove(host: AccountSwitchHost, sessionId: string, wanted: () => boolean) {
  const moves = chatMoves.get(host) ?? new Map<string, ChatMove>()
  chatMoves.set(host, moves)
  const pending = moves.get(sessionId)
  if (pending) {
    pending.again = true
    return pending.moved
  }
  const move: ChatMove = { again: true, moved: Promise.resolve() }
  moves.set(sessionId, move)
  move.moved = (async () => {
    try {
      while (move.again) {
        move.again = false
        await moveChat(host, sessionId, wanted)
      }
    } catch (error) {
      host.deps.logger.warn('moving a chat to the selected account failed', {
        scope: 'account-switch',
        sessionId,
        error
      })
    } finally {
      moves.delete(sessionId)
    }
  })()
  return move.moved
}

/** Resolves once every move ends. */
export function moveStructuredAgentSessionChatsToSelectedAccount(
  host: AccountSwitchHost,
  wanted: () => boolean
): Promise<void> {
  const { store } = host.deps
  const moves = host
    .loadedSessionIds()
    .filter((sessionId) => {
      const record = store.getRecord(sessionId)
      return (
        record?.provider === 'claude' &&
        record.location.executionHostId === store.hostId &&
        record.location.wslDistro === null
      )
    })
    .map((sessionId) => requestChatMove(host, sessionId, wanted))
  return Promise.all(moves).then(() => {})
}
