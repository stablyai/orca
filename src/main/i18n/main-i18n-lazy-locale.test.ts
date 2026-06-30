import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: main-i18n avoids bundling locale catalogs on the cold-start path.
// English comes from translateMain() fallbacks; non-English catalogs load
// through the backend before awaited menu/tray/dialog rendering reads them.

vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en-US')
  }
}))

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH
} from '../../shared/ui-language'
import { ensureMainI18n, setMainUiLanguage, translateMain } from './main-i18n'

describe('main-i18n lazy locale loading', () => {
  beforeEach(async () => {
    await ensureMainI18n()
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
    // If the lazy backend had not loaded es before changeLanguage settled, these
    // would fall back to the English defaults.
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
  })

  it('returns to English from a lazily-loaded locale', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    expect(translateMain('menu.file', 'File')).toBe('Archivo')

    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
    expect(translateMain('menu.file', 'File')).toBe('File')
  })
})
