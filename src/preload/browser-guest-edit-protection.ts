import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT
} from '../shared/browser/guest-lifecycle/browser-guest-discard-protection'

/** Private preload state: page code cannot report itself clean or read the challenge. */
export function installBrowserGuestEditProtection(port: {
  send: (channel: string, payload: unknown) => void
  on: (channel: string, listener: (payload: unknown) => void) => void
}): void {
  let dirty = false
  let generation: string | null = null
  let lastReportedDirty: boolean | undefined
  const report = (snapshot = false): void => {
    if (generation && (snapshot || dirty !== lastReportedDirty)) {
      lastReportedDirty = dirty
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { generation, dirty })
    }
  }
  const edited = (): void => {
    dirty = true
    report()
  }
  // Capture before page handlers; reset, submit and SPA steps do not retire the document's edits.
  window.addEventListener('input', edited, true)
  window.addEventListener('change', edited, true)
  port.on(BROWSER_GUEST_PROTECTION_CHALLENGE, (payload) => {
    if (typeof payload !== 'string') {
      return
    }
    generation = payload
    report(true)
  })
  window.addEventListener('pageshow', (event) => {
    if (event.isTrusted) {
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
    }
  })
  port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
}
