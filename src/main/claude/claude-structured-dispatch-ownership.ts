import type { ClaudeSession } from './claude-structured-session-state'

export function claudeCurrentDispatchHasRetiredWaiter(session: ClaudeSession): boolean {
  return session.retiredDispatchWaiters.some(
    (waiter) => waiter.dispatchSequence === session.dispatchSequence
  )
}
