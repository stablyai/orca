import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'

// Adopt durable state only when it restores a dialable credential; fresh renewals/re-pairing do not reliably increase version.
// Preserve rejection gates so a stale disk copy cannot resurrect a revoked credential.
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
    // Keep newer in-memory resume state when its durable write failed.
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
