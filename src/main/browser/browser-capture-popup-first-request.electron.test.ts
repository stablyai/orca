import { describe, expect, it } from 'vitest'
import { runBrowserCapturePopupFirstRequestProbe } from './browser-capture-popup-first-request-fixture'

// Why: the unit tests inject synthetic CDP events after a manual onPopupOpened,
// so they cannot show the creation hook runs before Chromium's first request.
// This probe runs Orca's exact production sequence (adopt contents, then attach
// the debugger synchronously in createWindow) in hidden windows and asserts the
// popup's first real navigation is recorded.
describe('browser popup first request under Electron', () => {
  it('captures the owned popup first navigation from the creation hook', async () => {
    const probe = await runBrowserCapturePopupFirstRequestProbe()

    // The navigation really happened against the local server.
    expect(probe.healthzHits).toBeGreaterThanOrEqual(1)
    // Exactly one captured /healthz document response — the first request.
    const healthzEntries = probe.capturedUrls.filter(
      (entry) => entry.url.includes('/healthz') && entry.type === 'Document'
    )
    expect(healthzEntries).toHaveLength(1)
    expect(healthzEntries[0].status).toBe(200)
  }, 90_000)
})
