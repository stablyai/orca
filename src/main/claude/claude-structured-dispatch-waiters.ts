import type { ClaudeDispatchWaiter, ClaudeSession } from './claude-structured-session-state'

const MAX_RETIRED_DISPATCH_WAITERS = 64

export function forgetRetiredWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.retiredDispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.retiredDispatchWaiters.splice(index, 1)
  }
}

/**
 * A waiter with no deadline. The echo Claude sends is emitted when the provider
 * STARTS the turn, so a message queued behind a running turn cannot be echoed
 * until that turn ends — an interval bounded only by the previous turn. Elapsed
 * time is therefore not evidence about delivery, and nothing here expires.
 * Waiters are retired by process facts instead: a failed write, or child exit.
 */
export function waitForReplay(
  session: ClaudeSession,
  acceptsResult: boolean,
  sentUuid: string,
  replayContentKey: string,
  clientMessageId: string | null,
  requestedAt: number | null
): { waiter: ClaudeDispatchWaiter; promise: Promise<string | null> } {
  let waiter!: ClaudeDispatchWaiter
  const promise = new Promise<string | null>((resolve) => {
    waiter = {
      acceptsResult,
      clientMessageId,
      sentUuid,
      dispatchSequence: session.dispatchSequence,
      requestedAt,
      replayContentKey,
      resolve
    }
    session.dispatchWaiters.push(waiter)
  })
  return { waiter, promise }
}

export function forgetWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.dispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.dispatchWaiters.splice(index, 1)
  }
}

export function retireWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  forgetWaiter(session, waiter)
  if (!waiter.retired) {
    waiter.retired = true
    session.retiredDispatchWaiters.push(waiter)
    if (session.retiredDispatchWaiters.length > MAX_RETIRED_DISPATCH_WAITERS) {
      session.replayContentFallbackBlocked = true
      session.retiredDispatchWaiters.splice(
        0,
        session.retiredDispatchWaiters.length - MAX_RETIRED_DISPATCH_WAITERS
      )
    }
  }
}
