import { publishProviderReceipt } from '../../../native-chat/agent-session-wire/journal-ingress/provider-receipt-publication'
import type { JournalHandoverIdentity } from '../../../native-chat/agent-session-journal/journal-store-contracts'
import type { ClaudeDispatchWaiter, ClaudeSession } from '../claude-structured-session-state'

export const MAX_ACTIVE_DISPATCH_WAITERS = 64
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
  requestedAt: number | null,
  dispatchFence = session.fence,
  handover?: JournalHandoverIdentity
): { waiter: ClaudeDispatchWaiter; promise: Promise<string | null> } {
  let waiter!: ClaudeDispatchWaiter
  const promise = new Promise<string | null>((resolve) => {
    waiter = {
      acceptsResult,
      clientMessageId,
      sentUuid,
      dispatchSequence: session.dispatchSequence,
      requestedAt,
      dispatchFence,
      handover,
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

export function withdrawClaudeDispatchReceipt(
  session: ClaudeSession,
  waiter: ClaudeDispatchWaiter
): void {
  if (waiter.clientMessageId !== null && waiter.handover !== undefined) {
    const { handover, clientMessageId, dispatchFence: fence } = waiter
    publishProviderReceipt(() =>
      session.events?.withdrawProviderReceipt?.({
        clientMessageId,
        ...handover,
        fence
      })
    )
  }
}

export function retireWaiter(session: ClaudeSession, waiter: ClaudeDispatchWaiter): void {
  forgetWaiter(session, waiter)
  if (!waiter.retired) {
    waiter.retired = true
    withdrawClaudeDispatchReceipt(session, waiter)
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
