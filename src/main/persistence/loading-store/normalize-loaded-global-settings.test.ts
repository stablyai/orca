import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import { resolveAntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { getDefaultPersistedState, getDefaultVoiceSettings } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
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

it('moves the old Toggle dictation default to Auto once and keeps Hold and later choices', () => {
  const voice = (dictationMode: string) => ({ ...getDefaultVoiceSettings(), dictationMode })
  const legacy = { voiceDictationModeDefaultedToAuto: undefined }

  const migrated = normalizeLegacyProfile({ ...legacy, voice: voice('toggle') })
  expect(migrated.voice?.dictationMode).toBe('auto')
  expect(migrated.voiceDictationModeDefaultedToAuto).toBe(true)
  expect(normalizeLegacyProfile({ ...legacy, voice: voice('hold') }).voice?.dictationMode).toBe(
    'hold'
  )
  expect(
    normalizeLegacyProfile({ voiceDictationModeDefaultedToAuto: true, voice: voice('toggle') })
      .voice?.dictationMode
  ).toBe('toggle')
})
