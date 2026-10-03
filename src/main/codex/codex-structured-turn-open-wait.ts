// A Stop's or a send's wait for the turn Codex answered a send into to open, or provably not
// to: it ended, the thread stopped running, or the child is gone. Held in memory only.

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

/**
 * The turn a Stop or a send names: the latest Codex reported started and not ended, or else the
 * one Codex answered a send into, once it opens. Null when none is running and that one ends, the
 * thread stops running or the child exits first, or the wait runs out; each such turn is waited
 * for once.
 */
export async function codexRunningOrOpeningTurn(session: {
  threadId: string
  activeTurnIds?: ReadonlySet<string>
  dispatchEchoes: Pick<CodexDispatchEchoes, 'answeredUnopenedTurn' | 'leftUnopened'>
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}): Promise<string | null> {
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
  // Codex refuses an interrupt, and before 0.148 a steer, until it opens the turn.
  await session.turnOpenWaits.wait(answered, CODEX_TURN_OPEN_WAIT_MS)
  if (session.activeTurnIds?.has(answered)) {
    return answered
  }
  // Before 0.148 a turn that fails before it starts reports no end; one that opens later is still
  // found running.
  session.dispatchEchoes.leftUnopened(session.threadId, answered)
  return null
}
