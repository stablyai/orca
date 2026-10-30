import { newChatPermissionModeForSettings } from '../../../shared/agent-chat-permission-mode'
import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { resolveAgentPermission } from '../../../shared/tui-agent-permission-choice'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'

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

describe('chat worker error preference upgrade', () => {
  it('defaults a truly missing saved key to on and preserves a saved opt-out', () => {
    const parsed = getDefaultPersistedState(homedir())
    delete parsed.settings.orchestrationChatErrorEscalationEnabled
    const normalize = () =>
      normalizeLoadedGlobalSettings(
        parsed,
        prepareLoadedTerminalSettings(parsed, () => {}),
        prepareLoadedProfileSettings(parsed, getDefaultPersistedState(homedir()), () => {})
      )
    expect(normalize().orchestrationChatErrorEscalationEnabled).toBe(true)
    parsed.settings.orchestrationChatErrorEscalationEnabled = false
    expect(normalize().orchestrationChatErrorEscalationEnabled).toBe(false)
  })
})

describe('retired setup placement', () => {
  it.each(['split-vertical', 'split-horizontal', 'new-tab', undefined])(
    'drops saved setup location %s without changing terminal preferences',
    (setupScriptLaunchMode) => {
      const normalized = normalizeLegacyProfile({
        setupScriptLaunchMode,
        terminalFocusFollowsMouse: true
      })
      expect(normalized).not.toHaveProperty('setupScriptLaunchMode')
      expect(normalized.terminalFocusFollowsMouse).toBe(true)
    }
  )
})

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

describe('retired managed servers experiment', () => {
  it('drops the stored toggle, since managed servers are the default SSH path', () => {
    expect('experimentalManagedServers' in normalizeLegacyProfile({})).toBe(false)
    expect(
      'experimentalManagedServers' in normalizeLegacyProfile({ experimentalManagedServers: true })
    ).toBe(false)
  })
})

describe('retired chat default selectors', () => {
  it('keeps Chat UI on while dropping both older keys from a saved profile', () => {
    const normalized = normalizeLegacyProfile({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: true
    })
    expect(normalized.experimentalNativeChat).toBe(true)
    expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
    expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
  })

  it('turns Chat UI off when new tabs opened in the terminal, dropping both older keys', () => {
    const normalized = normalizeLegacyProfile({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: false
    })
    expect(normalized.experimentalNativeChat).toBe(false)
    expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
    expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
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

describe('the new-chat permission setting', () => {
  it.each<{
    name: string
    saved: Partial<GlobalSettings>
    raw: string[]
    choices: string[]
    terminal: string[]
  }>([
    {
      name: 'mixed terminal permissions before the Chat seed exists',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: {
          claude: '--dangerously-skip-permissions --model sonnet',
          codex: '--approve-for-me --config tui.animations=false'
        }
      },
      raw: ['--model sonnet', '--config tui.animations=false'],
      choices: ['full-access', 'auto'],
      terminal: [
        '--dangerously-skip-permissions --model sonnet',
        '--approve-for-me --config tui.animations=false'
      ]
    },
    {
      name: 'explicit empty Arguments with saved Chat defaults',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: '', codex: '' },
        nativeChatPermissionMode: 'auto'
      },
      raw: ['', ''],
      choices: ['own', 'own'],
      terminal: ['', '']
    },
    {
      name: 'Claude plan text owned by the user',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: '--permission-mode plan --model sonnet', codex: '' },
        nativeChatPermissionMode: 'accept-edits'
      },
      raw: ['--permission-mode plan --model sonnet', ''],
      choices: ['own', 'own'],
      terminal: ['--permission-mode plan --model sonnet', '']
    },
    {
      name: 'legacy yolo defaults before either migration',
      saved: { agentYoloDefaultsMigrated: false, agentDefaultArgs: {} },
      raw: ['', ''],
      choices: ['full-access', 'full-access'],
      terminal: ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox']
    }
  ])(
    'loads and reloads $name through the real profile pipeline',
    ({ saved, raw, choices, terminal }) => {
      const defaults = getDefaultPersistedState(homedir())
      const retiredChatSettings = {
        agentNativeChatPermissionModes: { claude: 'ask', codex: 'auto' }
      }
      const parsed: PersistedState = {
        ...defaults,
        settings: {
          ...defaults.settings,
          agentPermissionDefault: undefined,
          agentPermissionOverrides: undefined,
          nativeChatPermissionMode: undefined,
          ...retiredChatSettings,
          agentDefaultEnv: { claude: { QA_LOADER_NOTE: 'preserved' } },
          ...saved
        }
      }
      const needsSave = vi.fn()
      const profile = prepareLoadedProfileSettings(parsed, defaults, needsSave)
      const loaded = normalizeLoadedGlobalSettings(
        parsed,
        prepareLoadedTerminalSettings(parsed, needsSave),
        profile
      )
      expect(needsSave).toHaveBeenCalled()
      expect(loaded.agentYoloDefaultsMigrated).toBe(true)
      expect(loaded.agentPermissionDefault).toBeDefined()
      expect(
        (['claude', 'codex'] as const).map((agent) =>
          newChatPermissionModeForSettings(agent, loaded)
        )
      ).toEqual(choices)
      expect(loaded).not.toHaveProperty('agentNativeChatPermissionModes')
      expect(loaded.agentDefaultEnv?.claude).toEqual({ QA_LOADER_NOTE: 'preserved' })
      expect(
        (['claude', 'codex'] as const).map((agent) => loaded.agentDefaultArgs?.[agent])
      ).toEqual(raw)
      expect(
        (['claude', 'codex'] as const).map((agent) => resolveAgentPermission(agent, loaded).choice)
      ).toEqual(choices)
      expect(
        (['claude', 'codex'] as const).map((agent) => resolveTuiAgentLaunchArgs(agent, loaded))
      ).toEqual(terminal)
      const reloaded: PersistedState = { ...parsed, settings: JSON.parse(JSON.stringify(loaded)) }
      expect(
        normalizeLoadedGlobalSettings(
          reloaded,
          prepareLoadedTerminalSettings(reloaded, needsSave),
          prepareLoadedProfileSettings(reloaded, defaults, needsSave)
        )
      ).toEqual(loaded)
    }
  )
})

describe('scoped new-chat permission defaults', () => {
  it('retires old chat copies while terminal intent and existing chat choices survive', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatPermissionMode: 'full-access',
      agentNativeChatPermissionModes: { codex: 'auto', claude: 'ask', omp: 'auto', unknown: 'auto' }
    })
    expect(normalized).not.toHaveProperty('agentNativeChatPermissionModes')
    expect(normalized.nativeChatPermissionMode).toBe('full-access')
  })
})

it('migrates a shipped split chat/terminal profile using terminal choices while retaining other saved data', () => {
  const normalized = normalizeLegacyProfile({
    agentPermissionDefault: undefined,
    agentPermissionOverrides: undefined,
    agentPermissionMigrated: false,
    agentDefaultArgs: { claude: '--model opus --permission-mode acceptEdits', codex: '' },
    nativeChatPermissionMode: 'ask',
    agentNativeChatPermissionModes: { claude: 'full-access', codex: 'auto' },
    nativeChatSessionOptions: {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }
    }
  })
  expect(normalized).not.toHaveProperty('agentNativeChatPermissionModes')
  expect(newChatPermissionModeForSettings('claude', normalized)).toBe('accept-edits')
  expect(newChatPermissionModeForSettings('codex', normalized)).toBe('own')
  expect(normalized.nativeChatPermissionMode).toBe('ask')
  expect(normalized.agentDefaultArgs?.claude).toBe('--model opus')
  expect(normalized.nativeChatSessionOptions?.claude).toEqual({
    model: 'opus',
    valuesByModel: { opus: { effort: 'high' } }
  })
})

describe('terminal default shell', () => {
  it('trims a hand-edited value and treats whitespace-only as unset', () => {
    expect(
      normalizeLegacyProfile({ terminalDefaultShell: '  /bin/zsh  ' }).terminalDefaultShell
    ).toBe('/bin/zsh')
    expect(normalizeLegacyProfile({ terminalDefaultShell: '   ' }).terminalDefaultShell).toBe('')
  })
})

it('loads an existing profile without a terminal policy mirror and preserves its saved preferences', () => {
  const loaded = normalizeLegacyProfile({
    terminalFocusFollowsMouse: true,
    machineName: 'Build server'
  })
  expect(loaded.terminalFocusFollowsMouse).toBe(true)
  expect(loaded.machineName).toBe('Build server')
  expect(loaded).not.toHaveProperty('maxTerminals')
})
