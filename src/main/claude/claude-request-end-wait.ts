// A Stop ends Claude's child. Before it does, Claude gets what is left of the grace to wind down what
// it has in flight through its own path: an unechoed send echoes and opens its turn, the stopped turn
// ends with its own result, and Claude writes both to its transcript. Keyed on Claude's own request,
// not on a journal turn: a Stop pressed before the echo has no turn row yet.

import type { ClaudeSession } from './claude-structured-session-state'

/** One budget from the Stop's interrupt: for Claude to answer it and wind its request down. */
export const CLAUDE_STOP_GRACE_MS = 3_000

const waiters = new WeakMap<ClaudeSession, Set<() => void>>()

/** Claude has a turn open, or a send it has not answered yet. */
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

/** Resolves once Claude has nothing in flight, re-read at each settle, or after `ms`. */
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
    // A settle that leaves something in flight, such as a subagent's result, waits on.
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

/** The adapter's wait: whatever of the grace the Stop's interrupt left, counted from `stoppedAt`. */
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

/** Something Claude had in flight settled: a result, the CLI's idle, the child's exit or its close. */
export function settleClaudeTurnEndWaiters(session: ClaudeSession): void {
  const waiting = waiters.get(session)
  waiters.delete(session)
  for (const wake of waiting ?? []) {
    wake()
  }
}
