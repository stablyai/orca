// #48712: a read whose registry lookup fails returns the settings as they are, not as they were.
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { Store } from '../../../persistence/loading-store/store'

const { listEnvironments } = vi.hoisted(() => ({ listEnvironments: vi.fn() }))

vi.mock('../../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments
}))

import { readSettingsWithRuntimeEnvironmentPreference } from './runtime-environment-preference'

function settingsStore(): Pick<Store, 'getSettings' | 'updateSettings'> {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/home'),
    activeRuntimeEnvironmentId: 'server-a',
    showMobileButton: false
  }
  return {
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    }
  }
}

describe('reading the settings under a registry lookup that fails', () => {
  it('returns the settings as they are when it fails, not the ones from before it', async () => {
    let failLookup!: (error: Error) => void
    listEnvironments.mockImplementation(
      () =>
        new Promise((_, reject) => {
          failLookup = reject
        })
    )
    const store = settingsStore()

    const read = readSettingsWithRuntimeEnvironmentPreference(store, '/user-data')
    // A change that lands while the lookup waits, as a menu toggle in another window does.
    store.updateSettings({ showMobileButton: true })
    failLookup(new Error('registry unavailable'))

    await expect(read).resolves.toMatchObject({ showMobileButton: true })
  })
})
