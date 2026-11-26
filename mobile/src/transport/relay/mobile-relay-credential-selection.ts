import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { pendingRelayCredentialLease } from './mobile-relay-credential-rotation'

// Dial order: pending is reached only after the relay refuses current and grace (or they expired here).
export function relayDialCandidates(
  bundle: MobileRelayCredentialBundle
): (MobileRelayCredentialBundle['current'] | null | undefined)[] {
  return [bundle.current, bundle.grace, pendingRelayCredentialLease(bundle)]
}

// Adopt durable state only when it restores a dialable credential; fresh renewals/re-pairing do not reliably increase version.
// Preserve rejection gates so a stale disk copy cannot resurrect a revoked credential.
export async function selectDialableRelayCredentials(args: {
  bundle: MobileRelayCredentialBundle | null
  controller: RelayReconnectController
  readBundle: () => Promise<MobileRelayCredentialBundle | null>
  pendingProven?: boolean
  onAdoptedFresherBundle: () => void
}): Promise<{
  bundle: MobileRelayCredentialBundle | null
  credentials: MobileRelayCredentialBundle['current'][]
}> {
  const memory = args.bundle
  const memoryCredentials = memory
    ? args.controller.eligibleCredentials(...relayDialCandidates(memory))
    : []
  // Pending alone is speculative, so reread durable state for a fresher credential, unless a 4404 just
  // proved it: that keeps the 5-15 s offline cadence, which must not read the keychain each time.
  const rereadForPending =
    memoryCredentials.every((credential) => credential.token === memory?.pending?.token) &&
    !args.pendingProven
  if (memoryCredentials.length > 0 && !rereadForPending) {
    // Keep newer in-memory resume state when its durable write failed.
    return { bundle: memory, credentials: memoryCredentials }
  }
  const disk = await args.readBundle().catch(() => null)
  if (disk && !(memoryCredentials.length > 0 && disk.current.token === memory?.current.token)) {
    const diskCredentials = args.controller.eligibleCredentials(...relayDialCandidates(disk))
    if (diskCredentials.length > 0) {
      args.controller.acceptFreshCredential(disk.current.version)
      args.onAdoptedFresherBundle()
      return { bundle: disk, credentials: diskCredentials }
    }
  }
  return { bundle: memory ?? disk, credentials: memoryCredentials }
}
