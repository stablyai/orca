import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncMacMenuBarIcon, syncNotchStatus } = vi.hoisted(() => ({
  syncMacMenuBarIcon: vi.fn(),
  syncNotchStatus: vi.fn()
}))
vi.mock('./main-window/main-window-actions', () => ({ syncMacMenuBarIcon }))
vi.mock('./notch-status-wiring', () => ({ syncNotchStatus }))
vi.mock('../browser/extensions/browser-extension-startup', () => ({
  switchBrowserExtensionSupport: vi.fn()
}))
vi.mock('./network-compatibility/http1-compatibility-marker', () => ({
  writeHttp1CompatibilityMarker: vi.fn()
}))

import { followNativeSettingChanges } from './native-setting-subscriptions'

type Listener = (updates: Record<string, unknown>, settings: Record<string, unknown>) => void

function follow(): Listener {
  let listener: Listener | null = null
  const projection = {
    onSettingsChanged: (next: Listener) => {
      listener = next
    }
  }
  followNativeSettingChanges(projection as never, {
    canonicalUserDataPath: '/tmp/orca',
    profileId: 'default',
    hangWatchdog: null
  })
  return listener!
}

describe('followNativeSettingChanges system presence', () => {
  beforeEach(() => {
    syncMacMenuBarIcon.mockClear()
    syncNotchStatus.mockClear()
  })

  it('syncs the notch when its setting changes', () => {
    follow()({ showNotchStatus: false }, { showNotchStatus: false })
    expect(syncNotchStatus).toHaveBeenCalledWith(false)
    expect(syncMacMenuBarIcon).not.toHaveBeenCalled()
  })

  it('still syncs the menu-bar icon', () => {
    follow()({ showMenuBarIcon: false }, { showMenuBarIcon: false })
    expect(syncMacMenuBarIcon).toHaveBeenCalledWith(false)
    expect(syncNotchStatus).not.toHaveBeenCalled()
  })
})
