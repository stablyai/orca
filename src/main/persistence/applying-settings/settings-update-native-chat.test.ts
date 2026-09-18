import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

/** Creates the persistence dependencies used by Native Chat settings tests. */
function makeOperations(): SettingsMutationOperations {
  return {
    state: getDefaultPersistedState(homedir()),
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('updateSettings nativeChatSendShortcut', () => {
  it('keeps supported values and normalizes malformed writes', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, { nativeChatSendShortcut: 'cmd-or-ctrl-enter' })
        .nativeChatSendShortcut
    ).toBe('cmd-or-ctrl-enter')
    expect(
      updateSettings(operations, JSON.parse('{"nativeChatSendShortcut":"bad-value"}'))
        .nativeChatSendShortcut
    ).toBe('enter')
  })
})
