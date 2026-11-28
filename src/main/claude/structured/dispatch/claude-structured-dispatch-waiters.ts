import type { ClaudeSession } from '../claude-structured-session-state'

export type ClaudeDispatchWaiter = {
  resolve: (uuid: string | null) => void
  acceptsResult: boolean
  /** Submission settled by the replay, or null for provider-control turns. */
  clientMessageId: string | null
  /** Client uuid echoed by Claude so a replay is tied to its own dispatch. */
  sentUuid: string
  /** Sequence used to identify the latest pending dispatch for control ownership. */
  dispatchSequence: number
  /** Host submission instant owned by this exact dispatch. */
  requestedAt: number | null
  /** Set when the provider replay settled this waiter before send returned. */
  settledUuid?: string
  /** Sent with priority `now`: the step it interrupts hands its open turn to this send. */
  steers?: true
  /** Settled with no echo (failed write, child exit, doubt after start); a replay may name it. */
  retired?: boolean
  providerReceived?: (isPending: () => boolean) => void
  /** The CLI's last non-terminal `command_lifecycle` state for this send; in memory only. */
  commandLifecycle?: 'queued' | 'started'
  /** Sent as Claude's rename command; only its started window carries the user's new title. */
  renamesSession?: true
  /** Bounded digest/summary for compatibility CLIs that mint UUIDs. */
  replayContentKey: string
}

const MAX_RETIRED_DISPATCH_WAITERS = 64

export function forgetRetiredWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  const index = session.retiredDispatchWaiters.indexOf(waiter)
  if (index !== -1) {
    session.retiredDispatchWaiters.splice(index, 1)
  }
}

/** Queued sends may wait a whole turn; only provider or process evidence settles delivery, never time. */
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
