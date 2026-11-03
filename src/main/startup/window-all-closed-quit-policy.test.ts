import { describe, expect, it } from 'vitest'
import { shouldQuitWhenAllWindowsClosed } from './window-all-closed-quit-policy'

const desktop = { isQuitting: false, isServeMode: false }

describe('shouldQuitWhenAllWindowsClosed', () => {
  it.each(['win32', 'linux'] as const)(
    'keeps %s startup alive when a helper window closes before the main window exists',
    (platform) => {
      expect(
        shouldQuitWhenAllWindowsClosed({ ...desktop, platform, hasOpenedMainWindow: false })
      ).toBe(false)
    }
  )

  it.each(['win32', 'linux'] as const)('quits %s after the last main window closes', (platform) => {
    expect(
      shouldQuitWhenAllWindowsClosed({ ...desktop, platform, hasOpenedMainWindow: true })
    ).toBe(true)
  })

  it('keeps macOS alive and quits once a quit is in progress', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({ ...desktop, platform: 'darwin', hasOpenedMainWindow: true })
    ).toBe(false)
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        isQuitting: true,
        isServeMode: true,
        hasOpenedMainWindow: false
      })
    ).toBe(true)
  })
})
