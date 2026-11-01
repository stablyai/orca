import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../../../shared/constants'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    state: getDefaultPersistedState(tmpdir()),
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('window material writes', () => {
  it.each([
    ['blur', true],
    ['translucent', true],
    ['off', false]
  ] as const)('mirrors %s into the legacy blur switch for rollback', (material, legacy) => {
    const operations = makeOperations()
    operations.state.settings.windowBackgroundBlur = !legacy
    updateSettings(operations, { windowMaterial: material })
    expect(operations.state.settings.windowBackgroundBlur).toBe(legacy)
  })
})
