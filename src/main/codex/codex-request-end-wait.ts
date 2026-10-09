import type { CodexSession } from './codex-structured-session-state'
import { codexStopTarget } from './codex-structured-turn-open-wait'

export const CODEX_STOP_GRACE_MS = 2_000
const waiters = new WeakMap<CodexSession, Set<() => void>>()

function requestInFlight(session: CodexSession): boolean {
  return !session.ended && (session.dispatchPending === true || codexStopTarget(session) !== null)
}

/** Re-reads the provider's turns after each settlement, within the original Stop's budget. */
export function codexStoppedRequestEndWait(
  sessions: ReadonlyMap<string, CodexSession>
): (sessionId: string, stoppedAt: number) => Promise<void> {
  return async (sessionId, stoppedAt) => {
    const session = sessions.get(sessionId)
    if (!session || !requestInFlight(session)) {
      return
    }
    let elapsed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          elapsed = true
          resolve()
        },
        Math.max(0, stoppedAt + CODEX_STOP_GRACE_MS - Date.now())
      )
      timer.unref?.()
    })
    try {
      while (!elapsed && requestInFlight(session)) {
        const waiting = waiters.get(session) ?? new Set<() => void>()
        waiters.set(session, waiting)
        const next = Promise.withResolvers<void>()
        waiting.add(next.resolve)
        try {
          await Promise.race([next.promise, budget])
        } finally {
          waiting.delete(next.resolve)
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function settleCodexRequestEndWaiters(session: CodexSession): void {
  const waiting = waiters.get(session)
  waiters.delete(session)
  for (const wake of waiting ?? []) {
    wake()
  }
}
