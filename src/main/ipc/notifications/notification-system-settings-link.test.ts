import { expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('../../app-profiles/app-profile', () => ({
  runtimeAppIdentity: () => ({
    productName: 'Orca - Work',
    appId: 'com.stablyai.orca.profile.work'
  })
}))

import { openNotificationSystemSettings } from './notification-system-settings-link'

it.runIf(process.platform === 'darwin')("opens the profile app's own notification settings", () => {
  vi.stubEnv('ORCA_DEV_MACOS_BUNDLE_ID', undefined)
  openNotificationSystemSettings()
  expect(openExternal).toHaveBeenCalledWith(
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.stablyai.orca.profile.work'
  )
  vi.unstubAllEnvs()
})
