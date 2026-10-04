import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'

function normalizeSettings(overrides: Record<string, unknown>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const parsed: PersistedState = {
    ...defaults,
    settings: { ...defaults.settings, ...overrides } as GlobalSettings
  }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

function normalizeUi(
  ui: Record<string, unknown>,
  loadedCompactWorktreeCards = false
): PersistedState['ui'] {
  const defaults = getDefaultPersistedState(homedir())
  const parsed: PersistedState = JSON.parse(
    JSON.stringify({ ...defaults, ui: { ...defaults.ui, ...ui } })
  )
  return normalizeLoadedUiState(
    parsed,
    defaults,
    defaults.onboarding!,
    loadedCompactWorktreeCards,
    false,
    vi.fn()
  )
}

describe('context-pressure settings on load', () => {
  it('normalizes thresholds and soft limits', () => {
    const settings = normalizeSettings({
      contextPressureWarnPercent: 0,
      contextPressureCriticalPercent: 'high',
      contextPressureSoftLimits: {
        ' Model:Claude-Opus-5 ': 400_000.9,
        codex: -1
      }
    })
    expect(settings.contextPressureWarnPercent).toBe(1)
    expect(settings.contextPressureCriticalPercent).toBe(90)
    expect(settings.contextPressureSoftLimits).toEqual({ 'model:claude-opus-5': 400_000 })
  })

  it('orders thresholds so critical never sits below warn', () => {
    const settings = normalizeSettings({
      contextPressureWarnPercent: 95,
      contextPressureCriticalPercent: 80
    })
    expect(settings.contextPressureWarnPercent).toBe(95)
    expect(settings.contextPressureCriticalPercent).toBe(95)
  })
})

describe('context-pressure card-property migration', () => {
  const legacyDefault = [
    'status',
    'unread',
    'issue',
    'linear-issue',
    'pr',
    'automation',
    'cli',
    'comment',
    'ports',
    'inline-agents'
  ]

  it('adds context pressure only to the previously auto-issued Default preset', () => {
    const ui = normalizeUi({
      worktreeCardProperties: legacyDefault,
      _worktreeCardModeDefaulted: true,
      _inlineAgentsDefaultedForAllUsers: true,
      _expandedWorktreeCardPropertiesDefaulted: true
    })
    expect(ui.worktreeCardProperties).toContain('context-pressure')
    expect(ui._contextPressureWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('preserves customized Default properties during the migration', () => {
    const ui = normalizeUi({
      worktreeCardProperties: ['status', 'unread', 'pr'],
      _worktreeCardModeDefaulted: true,
      _inlineAgentsDefaultedForAllUsers: true,
      _expandedWorktreeCardPropertiesDefaulted: true
    })
    expect(ui.worktreeCardProperties).toEqual(['status', 'unread', 'jira-issue', 'pr', 'host'])
    expect(ui._contextPressureWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('does not restore context pressure after a post-migration opt-out', () => {
    const ui = normalizeUi({
      worktreeCardProperties: legacyDefault,
      _worktreeCardModeDefaulted: true,
      _inlineAgentsDefaultedForAllUsers: true,
      _expandedWorktreeCardPropertiesDefaulted: true,
      _contextPressureWorktreeCardPropertyDefaulted: true
    })
    expect(ui.worktreeCardProperties).not.toContain('context-pressure')
  })

  it('upgrades a defaulted Compact preset to the gated context-pressure form', () => {
    const ui = normalizeUi(
      {
        worktreeCardProperties: ['status', 'unread'],
        _worktreeCardModeDefaulted: true,
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      true
    )
    expect(ui.worktreeCardProperties).toContain('context-pressure')
    expect(ui._contextPressureWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('preserves a post-migration Compact context-pressure opt-out', () => {
    const ui = normalizeUi(
      {
        worktreeCardProperties: ['status', 'unread'],
        _worktreeCardModeDefaulted: true,
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _contextPressureWorktreeCardPropertyDefaulted: true
      },
      true
    )
    expect(ui.worktreeCardProperties).toEqual(['status', 'unread', 'jira-issue', 'host'])
  })
})
