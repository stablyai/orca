import type { HostClientStoreEntry } from './host-entry-opener'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

export function shouldPreserveActiveRelay(
  entry: HostClientStoreEntry | undefined,
  logical: Partial<StableLogicalRpcClient> | undefined
): boolean {
  return Boolean(
    entry &&
    entry.state !== 'auth-failed' &&
    !logical?.isPairingRejected?.() &&
    logical?.getActivePath?.() === 'relay'
  )
}
