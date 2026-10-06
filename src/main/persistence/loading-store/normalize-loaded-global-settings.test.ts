import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

// Simulates a profile created before the dedicated Experimental switch was persisted.
function normalizeLegacyProfile(overrides: Record<string, unknown>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: Partial<GlobalSettings> = { ...defaults.settings }
  delete settings.experimentalActivity
  delete settings.experimentalAgentDashboardPopout
  Object.assign(settings, overrides)
  const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

describe('retired Agents sidebar setting', () => {
  it('does not mark new profiles as migrated', () => {
    expect(normalizeLegacyProfile({}).agentsSidebarMigratedFromExperimental).toBe(false)
  })

  it('drops the old visibility setting while preserving migration metadata', () => {
    const normalized = normalizeLegacyProfile({
      experimentalActivity: true,
      showAgentsSidebar: false
    })
    expect('showAgentsSidebar' in normalized).toBe(false)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(true)
  })
})

describe('structured chat shell environment settings', () => {
  it('keeps a valid saved list and an explicit opt-out', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(false)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([
      'HTTPS_PROXY',
      'CODEX_LB_API_KEY'
    ])
  })

  it('degrades a malformed hand-edited value to the defaults instead of failing a chat', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: 'no',
      nativeChatShellEnvironmentVariables: 'HTTPS_PROXY, CODEX_LB_API_KEY'
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(true)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([])
  })

  it('drops non-string and invalid entries from a saved list', () => {
    expect(
      normalizeLegacyProfile({
        nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 7, null, 'not valid', 'HTTPS_PROXY']
      }).nativeChatShellEnvironmentVariables
    ).toEqual(['HTTPS_PROXY'])
  })
})

describe('agent launch profile settings', () => {
  it('normalizes profile bindings on load and preserves older settings without profiles', () => {
    const profile = {
      id: 'work',
      name: 'Work',
      agent: 'codex',
      hostId: 'local',
      executable: '/opt/bin/codex',
      binding: { kind: 'external', home: '/profiles/work' }
    }
    expect(
      normalizeLegacyProfile({
        agentLaunchProfiles: [
          profile,
          { ...profile, id: 'bad', binding: { kind: 'external', home: 'relative' } }
        ]
      }).agentLaunchProfiles
    ).toEqual([profile])
    expect(normalizeLegacyProfile({}).agentLaunchProfiles).toEqual([])
  })
})

describe('machine name setting', () => {
  it('trims persisted names and defaults missing legacy values to automatic detection', () => {
    expect(normalizeLegacyProfile({ machineName: '  Build server  ' }).machineName).toBe(
      'Build server'
    )
    expect(normalizeLegacyProfile({ machineName: undefined }).machineName).toBe('')
    expect(normalizeLegacyProfile({ machineName: 'x'.repeat(300) }).machineName).toHaveLength(255)
  })
})

describe('chat appearance settings', () => {
  it('normalizes old and malformed profiles on load', () => {
    expect(normalizeLegacyProfile({}).nativeChatAppearance).toBeUndefined()
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 40, codeFontSize: 1, width: 'wide' }
      }).nativeChatAppearance
    ).toEqual({ fontSize: 20, codeFontSize: 10, width: 'wide' })
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 14, codeFontSize: 12, width: 'comfortable' }
      }).nativeChatAppearance
    ).toBeUndefined()
  })
})
