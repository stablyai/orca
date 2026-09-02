import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'

// Why: pairing recovery, re-pairing, or a raced rotation can land a fresh
// durable bundle after the supervisor snapshotted its copy; a gated retry must
// see it instead of dialing (or refusing to dial) on stale state forever.
//
// Adoption is decided by OUTCOME, not by version: renewals extend expiresAt
// without bumping current.version, and a re-pair restarts the version counter,
// so version comparison cannot tell fresh from stale. The durable bundle is
// adopted exactly when it yields a dialable (unexpired, non-rejected)
// credential while the in-memory one does not — which also means a revoked
// version can never be resurrected from a stale disk copy.
export async function selectDialableRelayCredentials(args: {
  bundle: MobileRelayCredentialBundle | null
  controller: RelayReconnectController
  readBundle: () => Promise<MobileRelayCredentialBundle | null>
  onAdoptedFresherBundle: () => void
}): Promise<{
  bundle: MobileRelayCredentialBundle | null
  credentials: MobileRelayCredentialBundle['current'][]
}> {
  const memory = args.bundle
  const memoryCredentials = memory
    ? args.controller.eligibleCredentials(memory.current, memory.grace)
    : []
  if (memoryCredentials.length > 0) {
    // Why: in-memory can be newer than disk (a resume confirmation whose
    // durable write failed); never let a stale disk copy shadow it.
    return { bundle: memory, credentials: memoryCredentials }
  }
  const disk = await args.readBundle().catch(() => null)
  if (disk) {
    const diskCredentials = args.controller.eligibleCredentials(disk.current, disk.grace)
    if (diskCredentials.length > 0) {
      args.controller.acceptFreshCredential(disk.current.version)
      args.onAdoptedFresherBundle()
      return { bundle: disk, credentials: diskCredentials }
    }
  }
  return { bundle: memory ?? disk, credentials: [] }
}
