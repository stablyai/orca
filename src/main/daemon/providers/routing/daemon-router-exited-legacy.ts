import { isDaemonEndpointGoneError } from '../../protocol/daemon-errors'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'

export type ExitedLegacyVerdict = 'retired' | 'already-retired' | 'not-exited'

/** Retirement requires both endpoint loss and process-exit proof; lost contact alone cannot prove absence. */
export function retireExitedLegacyAdapter(args: {
  adapter: DaemonPtyAdapter
  error: unknown
  current: DaemonPtyAdapter
  legacy: DaemonPtyAdapter[]
  exitProof: LegacyDaemonExitProof
  subscriptions: DaemonPtyAdapterSubscriptionFanout
}): ExitedLegacyVerdict {
  const { adapter } = args
  if (
    adapter === args.current ||
    !isDaemonEndpointGoneError(args.error) ||
    !args.exitProof.hasExited(adapter)
  ) {
    return 'not-exited'
  }
  return dropLegacyAdapter(adapter, args.legacy, args.subscriptions) ? 'retired' : 'already-retired'
}

/** Forgets an older generation that owns nothing any more and releases its connection. */
export function dropLegacyAdapter(
  adapter: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[],
  subscriptions: DaemonPtyAdapterSubscriptionFanout
): boolean {
  if (!unrouteLegacyAdapter(adapter, legacy)) {
    return false
  }
  releaseLegacyAdapter(adapter, subscriptions)
  return true
}

/** No more work goes to it; its exit subscription stays. */
export function unrouteLegacyAdapter(adapter: DaemonPtyAdapter, legacy: DaemonPtyAdapter[]): boolean {
  const index = legacy.indexOf(adapter)
  if (index === -1) {
    return false
  }
  legacy.splice(index, 1)
  return true
}

export function releaseLegacyAdapter(
  adapter: DaemonPtyAdapter,
  subscriptions: DaemonPtyAdapterSubscriptionFanout
): void {
  // The subscription fanout holds its own copy of the adapter list.
  subscriptions.dropAdapter(adapter)
  // Disconnect failure must not undo proven retirement.
  void Promise.resolve()
    .then(() => adapter.disconnectOnly())
    .catch(() => undefined)
}
