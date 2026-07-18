import { scheduleHostCredentialCleanup } from './host-credential-cleanup'

export async function scheduleOrphanedMobileRelayCleanup(args: {
  hostIds: string[]
  deleteCredential: (hostId: string) => Promise<void>
  removeOverlayIfHostAbsent: (hostId: string) => Promise<void>
  scheduleCleanup?: typeof scheduleHostCredentialCleanup
}): Promise<void> {
  const scheduleCleanup = args.scheduleCleanup ?? scheduleHostCredentialCleanup
  for (const hostId of new Set(args.hostIds)) {
    try {
      // Why: an older build may remove the legacy host while retaining the v2
      // namespace; persist keychain cleanup intent before dropping that pointer.
      const cleanupIntentDurable = await scheduleCleanup(hostId, args.deleteCredential)
      if (!cleanupIntentDurable) {
        // Why: SecureStore keys are not enumerable, so the overlay must remain
        // the durable retry pointer when the cleanup queue could not be written.
        continue
      }
      // Why: the missing base is authoritative, so a wedged optional-overlay
      // cleanup must not freeze host loading after deletion.
      void args.removeOverlayIfHostAbsent(hostId).catch(() => {})
    } catch {
      // Retain the overlay pointer if durable cleanup intent could not be recorded.
    }
  }
}
