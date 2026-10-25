import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

// #12881: unify zh provider-usage labels in repair policy so retranslation retains dropdown consistency.
// Scope excludes measured volume (使用量); full toggle sentences are pinned by catalog tests. ja remains split; ko is uniform.

// Real catalog keys, so a future zh key override shadowing one of these is caught here.
const STATUS_BAR_PROVIDERS = [
  ['auto.components.status.bar.StatusBar.3885eb74d8', 'Claude'],
  ['auto.components.status.bar.StatusBar.c0909c686e', 'Codex'],
  ['auto.components.status.bar.StatusBar.c1df0d67ec', 'Gemini'],
  ['auto.components.status.bar.StatusBar.antigravityUsage', 'Antigravity'],
  ['auto.components.status.bar.StatusBar.8c86cd77b0', 'OpenCode Go'],
  ['auto.components.status.bar.StatusBar.5e59007df4', 'Kimi'],
  ['auto.components.status.bar.StatusBar.3bbf140864', 'MiniMax'],
  ['auto.components.status.bar.StatusBar.grokUsageMenu', 'Grok'],
  ['auto.components.settings.accounts.search.f4a8c2e1b7', 'Grok (xAI)']
]

describe('locale-translation-policy zh status bar usage labels', () => {
  it('pins every provider usage label to 使用情况', () => {
    for (const [key, brand] of STATUS_BAR_PROVIDERS) {
      expect(
        repairTranslatedValue({
          key,
          enValue: `${brand} Usage`,
          localeValue: `${brand} 使用量`,
          locale: 'zh'
        }),
        brand
      ).toBe(`${brand} 使用情况`)
    }
  })

  it('reverts the Kimi transliteration in labels and search keywords', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.3a6c028ea8',
        enValue: 'Kimi Usage',
        localeValue: '基米用法',
        locale: 'zh'
      })
    ).toBe('Kimi 使用情况')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.40e5c3c285',
        enValue: 'kimi',
        localeValue: '基米',
        locale: 'zh'
      })
    ).toBe('kimi')
  })

  // NEVER_TRANSLATE_VALUES is cross-locale; moonshot repair must stay zh-scoped to preserve ja ムーンショット.
  it('keeps the moonshot keyword repair scoped to zh', () => {
    const key = 'auto.components.settings.appearance.search.35565867cb'
    expect(
      repairTranslatedValue({ key, enValue: 'moonshot', localeValue: '登月计划', locale: 'zh' })
    ).toBe('moonshot')
    expect(
      repairTranslatedValue({
        key,
        enValue: 'moonshot',
        localeValue: 'ムーンショット',
        locale: 'ja'
      })
    ).toBe('ムーンショット')
  })

  // Labels changed to 使用情况; 用量 search keyword preserves quota queries, while 用法 means how to use.
  it('keeps 用量 as the zh search keyword for "usage"', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.appearance.search.00a028f25f',
        enValue: 'usage',
        localeValue: '用法',
        locale: 'zh'
      })
    ).toBe('用量')
  })
})
