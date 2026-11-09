import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import { resolveAntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { getDefaultPersistedState, getDefaultVoiceSettings } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { buildKnownOrcaWorkspaceLayouts } from '../../../shared/worktree/ownership'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'

function normalizeLegacyProfile(overrides: Record<string, unknown>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const parsed: PersistedState = {
    ...defaults,
    settings: { ...defaults.settings, ...overrides }
  }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

it('keeps existing Antigravity profiles personal and preserves explicit or malformed saved choices for their owner', () => {
  expect(resolveAntigravityChatAuthConfig(normalizeLegacyProfile({}).antigravityChatAuth)).toEqual({
    method: 'oauth-personal'
  })
  const enterprise = {
    method: 'oauth-business',
    gcpProject: 'enterprise-project',
    gcpLocation: 'us-central1'
  }
  expect(normalizeLegacyProfile({ antigravityChatAuth: enterprise }).antigravityChatAuth).toEqual(
    enterprise
  )
  const malformed = normalizeLegacyProfile({ antigravityChatAuth: null }).antigravityChatAuth
  expect(malformed).toBeNull()
  expect(() => resolveAntigravityChatAuthConfig(malformed)).toThrow('account settings')
})

it('stores Auto as Toggle plus hold-to-record so older builds keep a working shortcut', () => {
  const { dictationHoldToRecord: _absentBeforeAuto, ...legacyVoice } = getDefaultVoiceSettings()
  const load = (voice: Record<string, unknown>, marked: boolean) => {
    const settings = normalizeLegacyProfile({
      voiceDictationModeDefaultedToAuto: marked ? true : undefined,
      voice: { ...legacyVoice, ...voice }
    })
    return [settings.voice?.dictationMode, settings.voice?.dictationHoldToRecord]
  }

  // The old Toggle default becomes Auto; Hold was always a choice.
  expect(load({ dictationMode: 'toggle' }, false)).toEqual(['toggle', true])
  expect(load({ dictationMode: 'hold' }, false)).toEqual(['hold', false])
  // Builds that stored Auto as 'auto', or a Toggle picked there, keep what the user had.
  expect(load({ dictationMode: 'auto' }, true)).toEqual(['toggle', true])
  expect(load({ dictationMode: 'toggle' }, true)).toEqual(['toggle', false])
  expect(load({ dictationMode: 'toggle', dictationHoldToRecord: false }, false)).toEqual([
    'toggle',
    false
  ])
})

it('loads a padded workspace directory as the absolute path while keeping its old root known', () => {
  const settings = normalizeLegacyProfile({
    workspaceDir: ' /Users/me/dev',
    nestWorkspaces: false,
    workspaceDirHistory: []
  })

  expect(settings.workspaceDir).toBe('/Users/me/dev')
  // Checkouts an older build placed under <repo>/ /Users/me/dev keep their known layout.
  expect(
    buildKnownOrcaWorkspaceLayouts(settings, { path: '/repo', worktreeBasePath: undefined }).map(
      (layout) => layout.path
    )
  ).toContain('/repo/ /Users/me/dev')
})
