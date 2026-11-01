import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-localization', () => ({ getLocales: () => [] }))

const { resolveUiLocaleFromTags } = await import('./system-ui-locale')

describe('resolveUiLocaleFromTags', () => {
  it.each([
    [['zh-Hant-TW'], 'zh-Hant'],
    [['zh-TW'], 'zh-Hant'],
    [['zh_HK'], 'zh-Hant'],
    [['zh-Hans-TW'], 'zh'],
    [['zh-Hant-CN'], 'zh-Hant'],
    [['zh-CN'], 'zh'],
    [['zh-Latn-CN', 'ja-JP'], 'ja'],
    [['pt-PT'], 'pt'],
    [['it-IT', 'de-AT'], 'de'],
    [['it-IT'], 'en'],
    [[], 'en'],
    [['', 'x-pseudo', 'tr'], 'tr']
  ])('resolves %j to %s', (tags, expected) => {
    expect(resolveUiLocaleFromTags(tags)).toBe(expected)
  })
})
