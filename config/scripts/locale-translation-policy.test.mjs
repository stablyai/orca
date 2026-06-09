import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

describe('locale-translation-policy', () => {
  it('keeps agent catalog labels in English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.760bc6883d',
        enValue: 'Codex',
        localeValue: '사본',
        locale: 'ko'
      })
    ).toBe('Codex')
  })

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

  it('fixes Dismiss homograph in Korean', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.store.slices.worktrees.889487d8bb',
        enValue: 'Dismiss',
        localeValue: '해고하다',
        locale: 'ko'
      })
    ).toBe('닫기')
  })

  it('fixes Gemini zodiac mistranslation in Chinese catalog', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.lib.agent.catalog.12e6baa4f7',
        enValue: 'Gemini',
        localeValue: '双子座',
        locale: 'zh'
      })
    ).toBe('Gemini')
  })

  it('preserves orca URL scheme in Chinese', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.web.WebConnect.27393856e4',
        enValue: 'orca://pair?code=...',
        localeValue: '虎鲸://pair?code=...',
        locale: 'zh'
      })
    ).toBe('orca://pair?code=...')
  })

  it('skips machine translation for standalone brands', () => {
    expect(shouldPreserveEnglishValue('Codex')).toBe(true)
    expect(shouldPreserveEnglishValue('Codex', 'auto.stats.StatsPane.7d26110cea')).toBe(true)
    expect(shouldPreserveEnglishValue('Show Codex usage')).toBe(false)
  })
})
