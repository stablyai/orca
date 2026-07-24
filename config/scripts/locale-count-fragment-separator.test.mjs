import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

// The theme-picker count row renders "Showing {count}" immediately followed by one of these
// fragments, so translations must keep a leading separator or the numbers fuse ("표시 중 3030 중").
describe('locale-count-fragment-separator', () => {
  it('keeps a slash between shown and total theme counts in CJK locales', () => {
    const brokenByLocale = { ko: '{{value0}} 중', ja: '{{value0}}の', zh: '{{value0}} 的' }
    for (const [locale, localeValue] of Object.entries(brokenByLocale)) {
      expect(
        repairTranslatedValue({
          key: 'auto.components.settings.SettingsFormControls.cb330ef7f8',
          enValue: ' of {{value0}}',
          localeValue,
          locale
        })
      ).toBe('/{{value0}}')
    }
  })

  it('keeps a leading space before the search-match fragment in CJK locales', () => {
    const cases = [
      ['ko', '"{{value0}}"과(와) 일치', ' "{{value0}}"과(와) 일치'],
      ['ja', '「{{value0}}」に一致', ' 「{{value0}}」に一致'],
      ['zh', '匹配“{{value0}}”', ' 匹配“{{value0}}”']
    ]
    for (const [locale, localeValue, repaired] of cases) {
      expect(
        repairTranslatedValue({
          key: 'auto.components.settings.SettingsFormControls.c822571b2e',
          enValue: ' matching "{{value0}}"',
          localeValue,
          locale
        })
      ).toBe(repaired)
    }
  })
})
