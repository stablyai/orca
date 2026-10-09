// A Stop's or a send's wait for the turn Codex answered a send into to open, or provably not
// to: it ended, the thread stopped running, or the child is gone. Held in memory only.

import type { AgentSessionCancelOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  codexThreadStoppedRunning,
  readCodexThreadId,
  readCodexTurnId
} from './codex-structured-thread-facts'

/** How long a Stop or a send waits for Codex to open the turn it answered a send into. A close or
 *  quit queued behind either spends this out of the eviction budget, so a full wait plus a slow
 *  provider close can overrun it; the next launch's recovery then settles the lease. */
export const CODEX_TURN_OPEN_WAIT_MS = 5_000

export type CodexTurnOpenWaits = {
  /** Resolves once `turnId` opens or can no longer, and after `withinMs` at the latest. */
  wait: (turnId: string, withinMs: number) => Promise<void>
  /** Ends the waits a notification on the session's own thread answers. */
  observe: (threadId: string, method: string, params: unknown) => void
  /** Ends every wait: the child that would open their turns is gone. */
  releaseAll: () => void
}

export function createCodexTurnOpenWaits(): CodexTurnOpenWaits {
  const waits = new Map<() => void, string>()
  const release = (turnId?: string): void => {
    for (const [endWait, waitedTurnId] of waits) {
      if (turnId === undefined || waitedTurnId === turnId) {
        endWait()
      }
    }
  }
  return {
    wait: (turnId, withinMs) =>
      new Promise<void>((resolve) => {
        const endWait = (): void => {
          clearTimeout(bound)
          waits.delete(endWait)
          resolve()
        }
        const bound = setTimeout(endWait, withinMs)
        // A Stop's wait must never be what keeps the process alive at quit.
        bound.unref?.()
        waits.set(endWait, turnId)
      }),
    observe: (threadId, method, params) => {
      if ((readCodexThreadId(params) ?? threadId) !== threadId) {
        return
      }
      if (method === 'thread/status/changed' && codexThreadStoppedRunning(params)) {
        release()
        return
      }
      const turnId = readCodexTurnId(params)
      if (turnId && (method === 'turn/started' || method === 'turn/completed')) {
        release(turnId)
      }
    },
    releaseAll: () => release()
  }
}

/** What a send finds to steer, or a Stop to interrupt: a turn running, or one Codex answered a send
 *  into that has not opened and has not ended, so may still open while its send is owed; null when
 *  neither. */
export type CodexStopTarget = { turnId: string } | { opening: string } | null

type CodexOpeningTurnSession = {
  threadId: string
  activeTurnIds?: ReadonlySet<string>
  dispatchEchoes: Pick<
    CodexDispatchEchoes,
    'answeredUnopenedTurn' | 'leftUnopened' | 'answeredTurnLeftUnopened'
  >
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}

/** The latest turn Codex reported started and not ended, or else the one it answered a send into
 *  that has neither opened nor ended, whether or not a wait already gave up on it. */
export function codexStopTarget(session: CodexOpeningTurnSession): CodexStopTarget {
  const running = [...(session.activeTurnIds ?? [])].at(-1)
  if (running) {
    return { turnId: running }
  }
  const open = session.activeTurnIds ?? new Set<string>()
  const opening =
    session.dispatchEchoes.answeredUnopenedTurn(session.threadId, open) ??
    session.dispatchEchoes.answeredTurnLeftUnopened(session.threadId, open)
  return opening ? { opening } : null
}

/** Codex's -32600 for an interrupt that finds no turn: before the turn has started running, or
 *  once it has ended. */
const CODEX_NO_ACTIVE_TURN_TO_INTERRUPT = 'no active turn to interrupt'

/**
 * A Stop of a turn Codex answered a send into that has not opened. Codex takes an interrupt as
 * soon as the turn starts, which can be before its `turn/started` is read, so it goes out at once.
 * Refused as finding no turn while that turn has yet to start, the Stop waits for it to open,
 * bounded, and sends it once more. A turn that ended meanwhile was nothing to stop. One that never
 * opens fails the Stop (`turnMayOpen`): it may still open and run, so the host ends the child.
 */
export async function interruptOpeningCodexTurn(
  session: CodexOpeningTurnSession,
  turnId: string,
  interrupt: () => Promise<AgentSessionCancelOutcome>,
  /** Whether the session the Stop began on still runs it, read after the wait. */
  stillCurrent: () => boolean
): Promise<AgentSessionCancelOutcome> {
  const open = (): ReadonlySet<string> => session.activeTurnIds ?? new Set<string>()
  const first = await interrupt()
  if (first.cancelled || first.refusal?.detail?.text !== CODEX_NO_ACTIVE_TURN_TO_INTERRUPT) {
    return first
  }
  const opened = (): boolean => open().has(turnId)
  const stillOpening = (): boolean => {
    const target = codexStopTarget(session)
    return target !== null && 'opening' in target && target.opening === turnId
  }
  if (!opened() && stillOpening()) {
    await session.turnOpenWaits.wait(turnId, CODEX_TURN_OPEN_WAIT_MS)
    if (!stillCurrent()) {
      return { cancelled: false }
    }
  }
  if (opened()) {
    return interrupt()
  }
  if (!stillOpening()) {
    // It ended: the Stop found no turn running.
    return { cancelled: false }
  }
  return { cancelled: false, refusal: { turnMayOpen: true } }
}

/**
 * The turn a send steers into: the running one, or else the one Codex answered a send into, once
 * it opens. Before 0.148 Codex refuses a steer until it opens the turn, so the send waits for that,
 * once per turn: a turn a wait left unopened is not waited for again. Null when no turn is running
 * by then.
 */
export async function codexRunningOrOpeningTurn(
  session: CodexOpeningTurnSession
): Promise<string | null> {
  const running = [...(session.activeTurnIds ?? [])].at(-1)
  if (running) {
    return running
  }
  const answered = session.dispatchEchoes.answeredUnopenedTurn(
    session.threadId,
    session.activeTurnIds ?? new Set<string>()
  )
  if (!answered) {
    return null
  }
  await session.turnOpenWaits.wait(answered, CODEX_TURN_OPEN_WAIT_MS)
  if (session.activeTurnIds?.has(answered)) {
    return answered
  }
  // Before 0.148 a turn that fails before it starts reports no end; one that opens later is still
  // found running.
  session.dispatchEchoes.leftUnopened(session.threadId, answered)
  return null
}
