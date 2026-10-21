import { isDaemonEndpointGoneError } from './daemon-errors'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'

export type ExitedLegacyVerdict = 'retired' | 'already-retired' | 'not-exited'

/**
 * Unlists a legacy daemon whose socket is gone and whose process has exited. Why both: a refused
 * socket alone is loss of contact, and only a vanished pid proves the daemon owns nothing.
 */
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
  // Why: the fanout was built from a copy of the adapters, so splicing the legacy list alone leaves it on the dead socket.
  args.subscriptions.dropAdapter(adapter)
  // Why: the socket is already gone; a failed disconnect must not fail the caller.
  void Promise.resolve()
    .then(() => adapter.disconnectOnly())
    .catch(() => undefined)
  return 'retired'
}
