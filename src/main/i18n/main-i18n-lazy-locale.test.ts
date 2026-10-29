import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// English uses fallbacks; awaited non-English catalogs must load without entering the cold-start bundle.

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US')
  }
}))

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_RUSSIAN,
  UI_LANGUAGE_SPANISH
} from '../../shared/ui-language'
import { mainI18n, setMainPluginLanguagePacks, setMainUiLanguage, translateMain } from './main-i18n'
import { pluginLanguageResourceId } from '../../shared/plugins/plugin-language-pack-artifact'

describe('main-i18n lazy locale loading', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    setMainPluginLanguagePacks([])
    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('serves English synchronously from caller fallbacks', () => {
    expect(translateMain('missing.main.key', 'Fallback copy')).toBe('Fallback copy')
    expect(translateMain('menu.file', 'File')).toBe('File')
    expect(translateMain('menu.settings', 'Settings')).toBe('Settings')
  })

  it('lazy-loads the Spanish catalog before changeLanguage resolves', async () => {
    const locale = await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(locale).toBe('es')
    // Missing the awaited backend load would return English fallbacks.
    expect(translateMain('menu.file', 'File')).toBe('Archivo')
    expect(translateMain('menu.settings', 'Settings')).toBe('Ajustes')
  })

  it('lazy-loads each remaining locale on demand', async () => {
    await setMainUiLanguage(UI_LANGUAGE_JAPANESE)
    expect(translateMain('menu.file', 'File')).not.toBe('File')

    await setMainUiLanguage(UI_LANGUAGE_KOREAN)
    expect(translateMain('menu.file', 'File')).not.toBe('File')

    await setMainUiLanguage(UI_LANGUAGE_CHINESE)
    expect(translateMain('menu.file', 'File')).not.toBe('File')

    await setMainUiLanguage(UI_LANGUAGE_PORTUGUESE)
    expect(translateMain('menu.file', 'File')).not.toBe('File')

    await setMainUiLanguage(UI_LANGUAGE_CHINESE_TRADITIONAL)
    expect(translateMain('menu.file', 'File')).not.toBe('File')
  })

  it('uses caller English when a target catalog omits a key', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(translateMain('missing.main.feature', 'English fallback')).toBe('English fallback')
  })

  it('loads Russian before native menu registration reads it', async () => {
    expect(await setMainUiLanguage(UI_LANGUAGE_RUSSIAN)).toBe('ru')
    expect(translateMain('menu.file', 'File')).toBe('Файл')
    expect(translateMain('menu.settings', 'Settings')).toBe('Настройки')
    // Production callers pass the literal `_other` key; Russian must still pick few/many.
    for (const [count, expected] of [
      [3, '3 активных терминала переподключатся после перезапуска.'],
      [5, '5 активных терминалов переподключатся после перезапуска.']
    ] as const) {
      expect(
        translateMain(
          'localBuild.liveTerminals_other',
          '{{count}} live terminals will reconnect after restart.',
          { count }
        )
      ).toBe(expected)
    }
  })

  it('returns to English from a lazily-loaded locale', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(translateMain('menu.file', 'File')).toBe('Archivo')

    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
    expect(translateMain('menu.file', 'File')).toBe('File')
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
    const id = 'plugin:orca-samples.portuguese/pt-BR' as const
    setMainPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-samples.portuguese',
        locale: 'pt-BR',
        catalog: { menu: { file: 'Arquivo Orca' } }
      }
    ])

    await setMainUiLanguage(id)
    expect(translateMain('menu.file', 'File')).toBe('Arquivo Orca')

    setMainPluginLanguagePacks([])
    expect(await setMainUiLanguage(id)).toBe('en')
    expect(translateMain('menu.file', 'File')).toBe('File')
  })

  it("uses a contributed pack's plural rules and English for its empty values", async () => {
    const id = 'plugin:orca-samples.russian/ru-RU' as const
    setMainPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-samples.russian',
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
      [1, 3, 5, 21].map((count) => translateMain('terminals_other', '{{count}} terms', { count }))
    ).toEqual(['1 one', '3 few', '5 other', '21 one'])
    expect(translateMain('empty', '{{count}} terminals', { count: 2 })).toBe('2 terminals')
  })
})
