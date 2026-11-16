import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// English uses fallbacks; awaited non-English catalogs must load without entering the cold-start bundle.

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US')
  }
}))

import { UI_LANGUAGE_ENGLISH } from '../../shared/i18n/ui-language'
import { mainI18n, setMainPluginLanguagePacks, setMainUiLanguage, translateMain } from './main-i18n'
import '../../shared/plugins/artifacts/plugin-language-pack-artifact'

describe('main-i18n lazy locale loading', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    setMainPluginLanguagePacks([])
    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
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
})
