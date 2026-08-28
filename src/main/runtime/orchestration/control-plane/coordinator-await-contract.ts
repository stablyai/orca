import type { MessageRow } from '../types'
import { selectWakeEvents, type CoordinatorWakeEvent } from './coordinator-wake-events'

/** B3 (correction 2) — the budget contract for the durable coordinator wait.
 *
 *  The point of these numbers is what they are NOT: they are not a 25, 30 or
 *  60 second model continuation window. The runtime holds the subscription for
 *  hours and re-arms its own internal slices; the model calls `await` once and
 *  yields until a real wake event arrives.
 */

/** How long the runtime holds one subscription when the caller says nothing. */
export const AWAIT_DEFAULT_BUDGET_MS = 6 * 60 * 60 * 1000

/** Hard ceiling for a single subscription. */
export const AWAIT_MAX_BUDGET_MS = 24 * 60 * 60 * 1000

/** Floor, so a caller cannot ask for a budget shorter than one sweep. */
export const AWAIT_MIN_BUDGET_MS = 60 * 1000

/** Internal slice length: how often the runtime re-arms and sweeps liveness.
 *  Invisible to the model — a slice expiring never returns control. */
export const AWAIT_SWEEP_INTERVAL_MS = 30 * 1000

export function clampAwaitBudgetMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return AWAIT_DEFAULT_BUDGET_MS
  }
  return Math.min(Math.max(timeoutMs, AWAIT_MIN_BUDGET_MS), AWAIT_MAX_BUDGET_MS)
}

/** Every wake event in a Delivery, in arrival order. An empty result means the
 *  runtime must keep waiting rather than hand control back. */
export function resolveAwaitWakeEvents(messages: readonly MessageRow[]): CoordinatorWakeEvent[] {
  return selectWakeEvents(messages)
}

/** A Delivery with no wake event must never end the subscription. */
export function shouldEndAwait(messages: readonly MessageRow[]): boolean {
  return resolveAwaitWakeEvents(messages).length > 0
}
