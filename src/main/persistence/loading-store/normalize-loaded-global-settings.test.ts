import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  normalizeClaudeManagedAccountRuntimes,
  normalizeLoadedGlobalSettings
} from './normalize-loaded-global-settings'
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

describe('normalizeClaudeManagedAccountRuntimes', () => {
  it('upgrades persisted accounts without a runtime to host isolation', () => {
    const legacy = { id: 'legacy', managedAuthRuntime: undefined }
    const wsl = { id: 'wsl', managedAuthRuntime: 'wsl' as const }

    const normalized = normalizeClaudeManagedAccountRuntimes([legacy, wsl] as never)

    expect(normalized.map((account) => account.managedAuthRuntime)).toEqual(['host', 'wsl'])
  })

  it('applies account runtime backfill through global settings normalization', () => {
    const parsed = getDefaultPersistedState('/tmp/orca-normalize-test')
    parsed.settings = {
      ...parsed.settings,
      claudeManagedAccounts: [{ id: 'legacy', managedAuthRuntime: undefined } as never]
    }
    const terminal = prepareLoadedTerminalSettings(parsed, () => {})
    const profile = prepareLoadedProfileSettings(parsed, terminal.defaults, () => {})

    const normalized = normalizeLoadedGlobalSettings(parsed, terminal, profile)

    expect(normalized.claudeManagedAccounts[0]?.managedAuthRuntime).toBe('host')
  })
})
