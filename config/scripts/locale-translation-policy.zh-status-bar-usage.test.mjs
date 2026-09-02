import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

// #12881 — the status bar item menu renders "<Brand> Usage" for every provider in one dropdown, so
// zh has to settle on a single word. Registering it here, not only in the catalog, is what makes a
// re-translation pass reproduce the decision instead of re-splitting the labels.
//
// Scope is the provider usage surfaces, not the word "usage" everywhere: a measured volume
// ("Daily usage" 每日使用量) stays 使用量. The toggle descriptions are pinned by the catalog test
// instead — LOCALE_VALUE_OVERRIDES keys on the exact English string, so full sentences do not fit.
//
// ja is split the same way zh was (使用量 vs の使用状況) and is not covered here; ko is uniform.

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

  // Why: NEVER_TRANSLATE_VALUES is cross-locale. Moving the moonshot repair there would rewrite
  // ja's ムーンショット, so it has to stay a zh-scoped BRAND_MISTRANSLATIONS entry.
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

  // Why: the labels moving to 使用情况 removed the only 用量-shaped match, so the search keyword
  // carries it. 用法 means "how to use".
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
