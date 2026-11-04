import { afterEach, describe, expect, it, vi } from 'vitest'
import es from '../../renderer/src/i18n/locales/es.json'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../shared/ui-language'
import { setMainUiLanguage, translateMain } from '../i18n/main-i18n'
import { formatProfileStateStartupFailure } from '../persistence/profile-state/profile-state-startup-failure'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))

afterEach(async () => {
  await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
})

describe('profile-state startup failure localization', () => {
  it('reads dialog copy from the active catalog and keeps commands verbatim', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(formatProfileStateStartupFailure({ code: 'newer-schema' }, translateMain)).toBe(
      es.profileState.startupFailure.newerSchema
    )
    const repair = formatProfileStateStartupFailure(
      {
        code: 'profile-state-recovery-required',
        dataFile: '/profile/orca-data.json',
        databaseFile: '/profile/profile-state.db',
        exportPaths: [],
        profileId: 'profile-a',
        repairableSections: [{ domain: 'settings' }]
      },
      translateMain
    )
    expect(repair).toContain(es.profileState.section.settings)
    expect(repair).toContain('`orca profile state rollback --repair --profile-id profile-a`')
    // Logs and the CLI keep English when no translator is passed.
    expect(formatProfileStateStartupFailure({ code: 'newer-schema' })).toContain(
      'newer version of Orca'
    )
  })
})
