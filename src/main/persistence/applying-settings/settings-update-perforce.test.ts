import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  DEFAULT_PERFORCE_SETTINGS,
  type PerforceSettings
} from '../../../shared/perforce/perforce-settings'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(perforce: PerforceSettings): SettingsMutationOperations {
  const state = getDefaultPersistedState(tmpdir())
  state.settings.perforce = perforce
  return {
    state,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('updateSettings perforce', () => {
  it('merges a partial update into the stored Perforce settings', () => {
    const operations = makeOperations({
      ...DEFAULT_PERFORCE_SETTINGS,
      p4Port: 'ssl:perforce.example.com:1666',
      refreshIntervalSeconds: 30
    })
    // settings:set forwards whatever the renderer sent; a partial nested object arrives as-is.
    const partial: Partial<PerforceSettings> = { showNewFiles: false }
    const updates = JSON.parse(JSON.stringify({ perforce: partial }))

    const updated = updateSettings(operations, updates).perforce

    expect(updated?.showNewFiles).toBe(false)
    expect(updated?.p4Port).toBe('ssl:perforce.example.com:1666')
    expect(updated?.refreshIntervalSeconds).toBe(30)
  })
})
