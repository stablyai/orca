import {
  loadMobileStructuredOutbox,
  type MobileStructuredOutboxEntry
} from './mobile-structured-outbox-store'

export type MobileStructuredOutboxHydration = {
  sessionId: string
  promise: Promise<void>
  cancel: () => void
}

export function startMobileStructuredOutboxHydration(
  sessionId: string,
  onHydrated: (entries: MobileStructuredOutboxEntry[]) => void
): MobileStructuredOutboxHydration {
  let stale = false
  const promise = loadMobileStructuredOutbox(sessionId).then((entries) => {
    if (!stale) {
      onHydrated(entries)
    }
  })
  return { sessionId, promise, cancel: () => (stale = true) }
}

export async function waitForMobileStructuredOutboxHydration(
  hydration: MobileStructuredOutboxHydration | null,
  sessionId: string
): Promise<boolean> {
  if (!hydration || hydration.sessionId !== sessionId) {
    return false
  }
  await hydration.promise
  return true
}
