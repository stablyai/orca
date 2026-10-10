import { afterEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import { setAppBundleId } from '../../shared/app-identity'
import { openNotificationSystemSettings } from './notification-system-settings-link'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  setAppBundleId(null)
  openExternal.mockClear()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('openNotificationSystemSettings', () => {
  it("opens the running app's macOS notification settings", () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const devBundleId = process.env.ORCA_DEV_MACOS_BUNDLE_ID
    delete process.env.ORCA_DEV_MACOS_BUNDLE_ID
    try {
      openNotificationSystemSettings()
      expect(openExternal).toHaveBeenLastCalledWith(
        expect.stringMatching(/\?id=com\.stablyai\.orca$/)
      )

      setAppBundleId('com.example.rebrand')
      openNotificationSystemSettings()
      expect(openExternal).toHaveBeenLastCalledWith(
        expect.stringMatching(/\?id=com\.example\.rebrand$/)
      )
    } finally {
      if (devBundleId !== undefined) {
        process.env.ORCA_DEV_MACOS_BUNDLE_ID = devBundleId
      }
    }
  })
})
