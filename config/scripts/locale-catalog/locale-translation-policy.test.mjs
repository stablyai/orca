import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy', () => {
  it('does not break Copy identifier when fixing Codex', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.example',
        enValue: 'Copy identifier',
        localeValue: '사본 식별자',
        locale: 'ko'
      })
    ).toBe('사본 식별자')
  })

  it('skips machine translation for standalone brands', () => {
    expect(shouldPreserveEnglishValue('Codex')).toBe(true)
    expect(shouldPreserveEnglishValue('Codex', 'auto.stats.StatsPane.7d26110cea')).toBe(true)
    expect(shouldPreserveEnglishValue('Show Codex usage')).toBe(false)
  })
})
