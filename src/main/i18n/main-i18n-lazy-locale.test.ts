import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// English uses fallbacks; awaited non-English catalogs must load without entering the cold-start bundle.

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US')
  }
}))

import {
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_GERMAN,
  UI_LANGUAGE_SPANISH
} from '../../shared/ui-language'
import { mainI18n, setMainPluginLanguagePacks, setMainUiLanguage, translateMain } from './main-i18n'
import { pluginLanguageResourceId } from '../../shared/plugins/artifacts/plugin-language-pack-artifact'

describe('main-i18n lazy locale loading', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    setMainPluginLanguagePacks([])
    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('lazy-loads the Spanish catalog before changeLanguage resolves', async () => {
    const locale = await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(locale).toBe('es')
    // Missing the awaited backend load would return English fallbacks.
    expect(translateMain('menu.file', 'File')).toBe('Archivo')
    expect(translateMain('menu.settings', 'Settings')).toBe('Ajustes')
  })

  it('keeps a newer explicit language when system fallback catalog loading finishes late', async () => {
    const { getSystemLanguageDetection } = await import('./system-language')
    expect(getSystemLanguageDetection(['fr-FR'])?.locale).toBe('fr')
    let finishLoad: () => void = () => {}
    const load = vi.spyOn(mainI18n, 'loadLanguages').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve
        })
    )
    const fallback = setMainUiLanguage('system')
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('fr'))
    await setMainUiLanguage('en')
    finishLoad()
    await fallback
    expect(mainI18n.language).toBe('en')
    expect(translateMain('menu.file', 'File')).toBe('File')
  })

  it('loads a contributed catalog for native menus and dialogs', async () => {
    const id = 'plugin:samples.portuguese/pt-BR' as const
    setMainPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'samples.portuguese',
        locale: 'pt-BR',
        catalog: { menu: { file: 'Arquivo Orca' } },
        coverage: 100
      }
    ])

    await setMainUiLanguage(id)
    expect(translateMain('menu.file', 'File')).toBe('Arquivo Orca')

    setMainPluginLanguagePacks([])
    expect(await setMainUiLanguage(id)).toBe('en')
    expect(translateMain('menu.file', 'File')).toBe('File')
  })

  it('still lazy-loads built-in catalogs after a pack is removed', async () => {
    const packs = ['orca-samples.first', 'orca-samples.second'].map((pluginKey) => {
      const id = `plugin:${pluginKey}/pt-BR` as const
      return {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey,
        coverage: 100,
        locale: 'pt-BR',
        catalog: { menu: { file: pluginKey } }
      }
    })
    setMainPluginLanguagePacks(packs)
    expect(setMainPluginLanguagePacks(packs.slice(1).map((pack) => structuredClone(pack)))).toBe(
      true
    )
    expect(setMainPluginLanguagePacks([structuredClone(packs[1])])).toBe(false)

    // German is not loaded by earlier tests, so this needs a backend load.
    await setMainUiLanguage(UI_LANGUAGE_GERMAN)
    expect(translateMain('menu.file', 'File')).toBe('Datei')
  })

  it("uses a contributed pack's plural rules and English for its empty values", async () => {
    const id = 'plugin:orca-samples.russian/ru-RU' as const
    setMainPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-samples.russian',
        coverage: 100,
        locale: 'ru-RU',
        catalog: {
          terminals_one: '{{count}} one',
          terminals_few: '{{count}} few',
          terminals_other: '{{count}} other',
          empty: ''
        }
      }
    ])
    await setMainUiLanguage(id)
    expect(
      [1, 3, 5, 21].map((count) => translateMain('terminals', '{{count}} terms', { count }))
    ).toEqual(['1 one', '3 few', '5 other', '21 one'])
    // A key the pack omits falls back to English chosen by English rules, not Russian's (21 is ru "one").
    expect(
      translateMain('missing.family', '{{count}} files', {
        count: 21,
        defaultValue_one: '{{count}} file'
      })
    ).toBe('21 files')
    expect(translateMain('empty', '{{count}} terminals', { count: 2 })).toBe('2 terminals')
  })
})
