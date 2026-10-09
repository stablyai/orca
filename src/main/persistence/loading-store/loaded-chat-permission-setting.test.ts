import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultPersistedState } from '../../../shared/constants'
import { applyAgentPermissionMode } from '../../../shared/tui-agent-permissions'
import { loadedChatPermissionSetting } from './loaded-chat-permission-setting'
import { normalizeLoadedProfileState } from './normalize-loaded-profile-state'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'

describe('one-time chat permission seed', () => {
  it.each([
    ['yolo', 'bypass'],
    ['manual', 'ask']
  ] as const)('seeds %s as %s and requests persistence', (mode, expected) => {
    const save = vi.fn()
    expect(loadedChatPermissionSetting(undefined, applyAgentPermissionMode({ mode }), save)).toBe(
      expected
    )
    expect(save).toHaveBeenCalledOnce()
  })
  it('seeds mixed permissions as Ask', () => {
    const terminal = applyAgentPermissionMode({ mode: 'yolo' })
    terminal.agentDefaultArgs.claude = ''
    expect(loadedChatPermissionSetting(undefined, terminal, vi.fn())).toBe('ask')
  })
  it('seeds a fresh profile from shipped Yolo defaults', () => {
    expect(loadedChatPermissionSetting(undefined, getDefaultSettings('/tmp'), vi.fn())).toBe(
      'bypass'
    )
  })
  it.each(['ask', 'accept-edits', 'auto', 'bypass'] as const)(
    'keeps saved %s independently of terminal changes',
    (mode) => {
      const save = vi.fn()
      expect(
        loadedChatPermissionSetting(mode, applyAgentPermissionMode({ mode: 'manual' }), save)
      ).toBe(mode)
      expect(
        loadedChatPermissionSetting(mode, applyAgentPermissionMode({ mode: 'yolo' }), save)
      ).toBe(mode)
      expect(save).not.toHaveBeenCalled()
    }
  )
  it.each(['future', null, 42])('normalizes unknown %s to Ask and saves it', (value) => {
    const save = vi.fn()
    expect(loadedChatPermissionSetting(value, getDefaultSettings('/tmp'), save)).toBe('ask')
    expect(save).toHaveBeenCalledOnce()
  })
  it('persists through profile normalization and never reseeds after terminal changes', () => {
    const parsed = getDefaultPersistedState('/tmp')
    delete parsed.settings.nativeChatPermissionMode
    Object.assign(parsed.settings, applyAgentPermissionMode({ mode: 'manual' }))
    const save = vi.fn()
    const normalized = normalizeLoadedProfileState(
      parsed,
      prepareLoadedTerminalSettings(parsed, save),
      prepareLoadedProfileSettings(parsed, parsed, save),
      save
    )
    expect(normalized.settings.nativeChatPermissionMode).toBe('ask')
    expect(save).toHaveBeenCalled()
    Object.assign(normalized.settings, applyAgentPermissionMode({ mode: 'yolo' }))
    const reloaded = normalizeLoadedProfileState(
      normalized,
      prepareLoadedTerminalSettings(normalized, save),
      prepareLoadedProfileSettings(normalized, normalized, save),
      save
    )
    expect(reloaded.settings.nativeChatPermissionMode).toBe('ask')
  })
})
