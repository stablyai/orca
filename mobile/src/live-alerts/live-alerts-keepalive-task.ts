/** Started by the native module while its foreground service runs (OrcaLiveAlertsModule.kt). */
export const LIVE_ALERTS_KEEP_ALIVE_TASK = 'OrcaLiveAlertsKeepAlive'

const pendingReleases = new Set<() => void>()

/**
 * The headless task body. React Native keeps JS timers firing in the background only while a
 * headless task runs, so this does nothing but stay open until the live notification ends.
 * live-alerts-keepalive-registration.ts registers it; this module has no side effects.
 */
export function runLiveAlertsKeepAlive(): Promise<void> {
  return new Promise((resolve) => {
    pendingReleases.add(() => resolve())
  })
}

/** Ends every running keep-alive task, so React Native may pause timers again. */
export function releaseLiveAlertsKeepAlive(): void {
  const releases = [...pendingReleases]
  pendingReleases.clear()
  for (const release of releases) {
    release()
  }
}
