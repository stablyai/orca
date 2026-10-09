import { expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedProfileState } from '../loading-store/normalize-loaded-profile-state'
import { prepareLoadedProfileSettings } from '../loading-store/prepare-loaded-profile-settings'
import { prepareLoadedTerminalSettings } from '../loading-store/prepare-loaded-terminal-settings'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function operations(): SettingsMutationOperations {
  return {
    state: getDefaultPersistedState(''),
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

it.each(['ask', 'bypass'] as const)(
  'saves each change away from %s and retains it after loading',
  (initial) => {
    const ops = operations()
    ops.state.settings.nativeChatPermissionMode = initial
    const saved: (typeof ops.state.settings)[] = []
    ops.scheduleSave = () => saved.push(structuredClone(ops.state.settings))
    const other = initial === 'ask' ? 'bypass' : 'ask'
    updateSettings(ops, { nativeChatPermissionMode: other }, { notifyListeners: true })
    expect(saved[0]).toMatchObject({
      nativeChatPermissionMode: other
    })
    expect(ops.notifySettingsChanged).toHaveBeenCalledWith(
      { nativeChatPermissionMode: other },
      undefined
    )
    updateSettings(ops, { nativeChatPermissionMode: initial })
    expect(saved[1]).toMatchObject({
      nativeChatPermissionMode: initial
    })
    const persisted = { ...ops.state, settings: saved[1] }
    const loaded = normalizeLoadedProfileState(
      persisted,
      prepareLoadedTerminalSettings(persisted, () => {}),
      prepareLoadedProfileSettings(persisted, persisted, () => {}),
      () => {}
    )
    ops.state = loaded
    updateSettings(ops, { nativeChatPermissionMode: other })
    expect(ops.state.settings.nativeChatPermissionMode).toBe(other)
  }
)
