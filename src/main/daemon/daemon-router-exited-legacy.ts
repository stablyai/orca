import { isDaemonEndpointGoneError } from './daemon-errors'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
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
  const index = args.legacy.indexOf(adapter)
  if (index === -1) {
    return 'already-retired'
  }
  args.legacy.splice(index, 1)
  // The subscription fanout holds its own copy of the adapter list.
  args.subscriptions.dropAdapter(adapter)
  // Disconnect failure must not undo proven retirement.
  void Promise.resolve()
    .then(() => adapter.disconnectOnly())
    .catch(() => undefined)
  return 'retired'
}
