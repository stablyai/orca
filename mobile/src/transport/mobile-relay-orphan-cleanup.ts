import { scheduleHostCredentialCleanup } from './host-credential-cleanup'
import { removeMobileRelayHostRouting } from './mobile-relay-host-overlay-store'

export async function scheduleOrphanedMobileRelayCleanup(args: {
  hostIds: string[]
  deleteCredential: (hostId: string) => Promise<void>
  scheduleCleanup?: typeof scheduleHostCredentialCleanup
  removeOverlay?: typeof removeMobileRelayHostRouting
}): Promise<void> {
  const scheduleCleanup = args.scheduleCleanup ?? scheduleHostCredentialCleanup
  const removeOverlay = args.removeOverlay ?? removeMobileRelayHostRouting
  for (const hostId of new Set(args.hostIds)) {
    try {
      // Persist keychain cleanup intent before removing an overlay orphaned by an older build’s host removal.
      await scheduleCleanup(hostId, args.deleteCredential)
      await removeOverlay(hostId)
    } catch {
      // Retain the overlay pointer if durable cleanup intent could not be recorded.
    }
  }
}
