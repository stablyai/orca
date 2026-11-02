// Stop grace follows the provider request, including sends whose echo has not opened a turn yet.

import type { ClaudeSession } from './structured/claude-structured-session-state'

/** Interrupt acknowledgement and request wind-down share this budget. */
export const CLAUDE_STOP_GRACE_MS = 3_000

const waiters = new WeakMap<ClaudeSession, Set<() => void>>()

function claudeRequestInFlight(session: ClaudeSession): boolean {
  return (session.translator?.currentTurnId ?? null) !== null || session.dispatchWaiters.length > 0
}

function nextSettle(session: ClaudeSession): { settled: Promise<void>; forget: () => void } {
  let waiting = waiters.get(session)
  if (!waiting) {
    waiting = new Set()
    waiters.set(session, waiting)
  }
  const set = waiting
  let wake!: () => void
  const settled = new Promise<void>((resolve) => {
    wake = resolve
  })
  set.add(wake)
  return { settled, forget: () => set.delete(wake) }
}

export async function awaitClaudeRequestEnd(session: ClaudeSession, ms: number): Promise<void> {
  let elapsed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      elapsed = true
      resolve()
    }, ms)
    timer.unref?.()
  })
  try {
    // Subagent results can wake this loop while the main request remains in flight.
    while (!elapsed && claudeRequestInFlight(session)) {
      const next = nextSettle(session)
      try {
        await Promise.race([next.settled, budget])
      } finally {
        next.forget()
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

export function claudeStoppedRequestEndWait(
  sessions: Map<string, ClaudeSession>
): (sessionId: string, stoppedAt: number) => Promise<void> {
  return async (sessionId, stoppedAt) => {
    const session = sessions.get(sessionId)
    if (session) {
      await awaitClaudeRequestEnd(
        session,
        Math.max(0, stoppedAt + CLAUDE_STOP_GRACE_MS - Date.now())
      )
    }
  }
}

export function settleClaudeTurnEndWaiters(session: ClaudeSession): void {
  const waiting = waiters.get(session)
  waiters.delete(session)
  for (const wake of waiting ?? []) {
    wake()
  }
}
