import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock, bundleIdMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  bundleIdMock: vi.fn<() => string | null>()
}))

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))
vi.mock('../macos-bundle-identifier', () => ({ getMacBundleIdentifier: bundleIdMock }))

import { openNotificationSystemSettings } from './notification-system-settings-link'

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'

describe('openNotificationSystemSettings on macOS', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.stubEnv('ORCA_DEV_MACOS_BUNDLE_ID', undefined)
    openExternalMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it("opens the running bundle's own pane for a renamed build", () => {
    bundleIdMock.mockReturnValue('com.example.fork')
    openNotificationSystemSettings()
    expect(openExternalMock).toHaveBeenCalledWith(`${SETTINGS_URL}?id=com.example.fork`)
  })

  it('falls back to the packaged id when the bundle cannot be read', () => {
    bundleIdMock.mockReturnValue(null)
    openNotificationSystemSettings()
    expect(openExternalMock).toHaveBeenCalledWith(`${SETTINGS_URL}?id=com.stablyai.orca`)
  })
})
