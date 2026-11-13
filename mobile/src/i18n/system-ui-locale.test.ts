import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-localization', () => ({ getLocales: () => [] }))

const { resolveUiLocaleFromTags } = await import('./system-ui-locale')

describe('resolveUiLocaleFromTags', () => {
  it.each([
    [['zh_HK'], 'zh-Hant'],
    [['zh-Hans-TW'], 'zh'],
    [['zh-Hant-CN'], 'zh-Hant'],
    [['zh-Latn-CN', 'ja-JP'], 'ja'],
    [['it-IT', 'de-AT'], 'de'],
    [['', 'x-pseudo', 'tr'], 'tr']
  ])('resolves %j to %s', (tags, expected) => {
    expect(resolveUiLocaleFromTags(tags)).toBe(expected)
  })
})
