import { scheduleHostCredentialCleanup } from './host-credential-cleanup'
import { removeMobileRelayHostOverlay } from './mobile-relay-host-overlay-store'

export async function scheduleOrphanedMobileRelayCleanup(args: {
  hostIds: string[]
  deleteCredential: (hostId: string) => Promise<void>
  scheduleCleanup?: typeof scheduleHostCredentialCleanup
  removeOverlay?: typeof removeMobileRelayHostOverlay
}): Promise<void> {
  const scheduleCleanup = args.scheduleCleanup ?? scheduleHostCredentialCleanup
  const removeOverlay = args.removeOverlay ?? removeMobileRelayHostOverlay
  for (const hostId of new Set(args.hostIds)) {
    try {
      // Why: an older build may remove the legacy host while retaining the v2
      // namespace; persist keychain cleanup intent before dropping that pointer.
      await scheduleCleanup(hostId, args.deleteCredential)
      await removeOverlay(hostId)
    } catch {
      // Retain the overlay pointer if durable cleanup intent could not be recorded.
    }
  }
}
