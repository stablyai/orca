import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readSettingsWithRuntimeEnvironmentPreference } from './runtime-environment-preference'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-runtime-preference-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readSettingsWithRuntimeEnvironmentPreference', () => {
  it('replies with settings accepted while the unreadable registry was being read', async () => {
    let settings: GlobalSettings = {
      ...getDefaultPersistedState(dir).settings,
      activeRuntimeEnvironmentId: 'env-1',
      httpLinkClickBehavior: 'ask'
    }
    const store = {
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => (settings = { ...settings, ...updates })
    }
    // No registry file exists under dir, so the read fails after its await.
    const reading = readSettingsWithRuntimeEnvironmentPreference(store, dir)
    store.updateSettings({ httpLinkClickBehavior: 'open' })
    expect((await reading).httpLinkClickBehavior).toBe('open')
  })
})
