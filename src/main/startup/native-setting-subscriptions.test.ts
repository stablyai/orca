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
import type { NativeSettingsProjection } from '../core-desktop/native-settings-projection'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'

type Listener = Parameters<NativeSettingsProjection['onSettingsChanged']>[0]

function settingsWith(updates: Partial<GlobalSettings>): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...updates }
}

function follow(): Listener {
  let listener: Listener | null = null
  const projection: NativeSettingsProjection = {
    getSettings: () => settingsWith({}),
    getUI: () => {
      throw new Error('not used')
    },
    onSettingsChanged: (next) => {
      listener = next
      return () => undefined
    },
    onUIChanged: () => () => undefined,
    requestCoreWrite: async () => undefined
  }
  followNativeSettingChanges(projection, {
    canonicalUserDataPath: '/tmp/orca',
    profileId: 'default',
    hangWatchdog: null
  })
  if (!listener) {
    throw new Error('listener was not registered')
  }
  return listener
}

describe('followNativeSettingChanges system presence', () => {
  beforeEach(() => {
    syncMacMenuBarIcon.mockClear()
    syncNotchStatus.mockClear()
  })

  it('syncs the notch when its setting changes', () => {
    follow()({ showNotchStatus: false }, settingsWith({ showNotchStatus: false }))
    expect(syncNotchStatus).toHaveBeenCalledWith(false)
    expect(syncMacMenuBarIcon).not.toHaveBeenCalled()
  })

  it('still syncs the menu-bar icon', () => {
    follow()({ showMenuBarIcon: false }, settingsWith({ showMenuBarIcon: false }))
    expect(syncMacMenuBarIcon).toHaveBeenCalledWith(false)
    expect(syncNotchStatus).not.toHaveBeenCalled()
  })
})
