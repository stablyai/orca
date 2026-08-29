import { describe, expect, it } from 'vitest'
import { shouldDeferKeyringProbe } from './keyring-probe-deferral'

describe('shouldDeferKeyringProbe', () => {
  it('defers on Linux desktop, the only host where the probe can block forever', () => {
    expect(shouldDeferKeyringProbe({ platform: 'linux', isServeMode: false })).toBe(true)
  })

  it('never defers in serve mode, which advertises readiness with no window to defer behind', () => {
    // Why pinned separately from the platform gate: this is the regression a reviewer caught on
    // the sibling leg (STA-5765) — deferring here moves the block past the point clients pair.
    expect(shouldDeferKeyringProbe({ platform: 'linux', isServeMode: true })).toBe(false)
  })

  it('never defers on macOS or Windows, whose keychains answer promptly', () => {
    // Why both listed: a platform gate that accidentally widened to every desktop would withhold
    // secrets for the whole pre-window startup on hosts that never had the hazard.
    expect(shouldDeferKeyringProbe({ platform: 'darwin', isServeMode: false })).toBe(false)
    expect(shouldDeferKeyringProbe({ platform: 'win32', isServeMode: false })).toBe(false)
  })

  it('never defers on a non-Linux serve host either', () => {
    expect(shouldDeferKeyringProbe({ platform: 'darwin', isServeMode: true })).toBe(false)
  })
})
