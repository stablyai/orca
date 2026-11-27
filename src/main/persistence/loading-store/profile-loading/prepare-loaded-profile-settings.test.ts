import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'

function prepare(settings: Record<string, unknown>) {
  const defaults = getDefaultPersistedState('/home/test')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture only fills the settings fields under test.
  const parsed = { ...defaults, settings: { ...defaults.settings, ...settings } } as PersistedState
  return prepareLoadedProfileSettings(parsed, defaults, vi.fn())
}

describe('itsaplan visible provider migration', () => {
  it('appends itsaplan once for a profile that never saw it', () => {
    const { taskProviderSettings } = prepare({
      visibleTaskProviders: ['github', 'jira'],
      visibleTaskProvidersDefaultedForJira: true,
      visibleTaskProvidersDefaultedForItsaplan: undefined
    })
    expect(taskProviderSettings.visibleTaskProviders).toEqual(['github', 'jira', 'itsaplan'])
  })

  it('keeps itsaplan hidden after the migration flag is set', () => {
    const { taskProviderSettings } = prepare({
      visibleTaskProviders: ['github'],
      visibleTaskProvidersDefaultedForJira: true,
      visibleTaskProvidersDefaultedForItsaplan: true
    })
    expect(taskProviderSettings.visibleTaskProviders).toEqual(['github'])
  })
})
