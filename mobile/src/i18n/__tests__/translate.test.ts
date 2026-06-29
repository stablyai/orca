import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('expo-localization', () => ({
  getLocales: vi.fn()
}))

import { initI18n } from '../init'
import { translate } from '../translate'

beforeEach(async () => {
  await initI18n('zh')
})

describe('translate()', () => {
  it('returns Chinese when key exists in active locale', () => {
    expect(translate('mobile.settings.title', 'Settings')).toBe('设置')
  })

  it('returns English fallback when key is missing', () => {
    expect(translate('mobile.nonexistent.key', 'My English Fallback')).toBe('My English Fallback')
  })

  it('interpolates {{var}} placeholders', () => {
    expect(translate('mobile.pair.codeLabel', 'Code: {{code}}', { code: '123' })).toBe('Code: 123')
  })

  it('updates when language changes', async () => {
    const { getI18n } = await import('../init')
    expect(translate('mobile.settings.title', 'Settings')).toBe('设置')
    await getI18n().changeLanguage('en')
    expect(translate('mobile.settings.title', 'Settings')).toBe('Settings')
    await getI18n().changeLanguage('zh')
  })
})
