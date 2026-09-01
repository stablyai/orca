// Ephemeral host-wide in-flight join registry for `worktree.retryAgentLaunch`.
// A retry launch is registered here by idempotency key while it runs so a
// concurrent duplicate (double-click, client reconnect) joins the same promise
// instead of starting a second launch; the entry clears when the promise
// settles. This is in-memory only — cross-restart idempotency is the durable
// settled ledger's job, not this registry's.

import type {
  WorktreeRetryAgentLaunchResult,
  WorktreeRetryInFlight
} from './agent-launch-worktree-retry'

const inFlightByKey = new Map<string, WorktreeRetryInFlight>()

export function findWorktreeRetryInFlight(idempotencyKey: string): WorktreeRetryInFlight | null {
  return inFlightByKey.get(idempotencyKey) ?? null
}

export function registerWorktreeRetryInFlight(
  idempotencyKey: string,
  payloadDigest: string,
  promise: Promise<WorktreeRetryAgentLaunchResult>
): void {
  inFlightByKey.set(idempotencyKey, { payloadDigest, promise })
  const clear = (): void => {
    // Only clear our own entry — a newer duplicate may have replaced it.
    if (inFlightByKey.get(idempotencyKey)?.promise === promise) {
      inFlightByKey.delete(idempotencyKey)
    }
  }
  void promise.then(clear, clear)
}
