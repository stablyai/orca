import fs from 'node:fs'

import { describe, expect, it } from 'vitest'
import { repairTranslatedValue } from './locale-translation-policy.mjs'

const LOCALES = ['es', 'ja', 'ko', 'zh']
const KEYS = [
  'auto.hooks.useMacosTccPromptNotice.title',
  'auto.hooks.useMacosTccPromptNotice.description',
  'auto.hooks.useMacosTccPromptNotice.openSettings',
  'auto.hooks.useMacosTccPromptNotice.dismiss',
  'auto.components.settings.DeveloperPermissionsPane.7ca17b62c8',
  'auto.components.settings.DeveloperPermissionsPane.c566bca278'
]

function readCatalog(locale) {
  return JSON.parse(
    fs.readFileSync(
      new URL(`../../src/renderer/src/i18n/locales/${locale}.json`, import.meta.url),
      'utf8'
    )
  )
}

function getValue(catalog, key) {
  return key.split('.').reduce((value, part) => value[part], catalog)
}

describe('macOS TCC prompt localization', () => {
  it('survives the canonical catalog repair policy', () => {
    const english = readCatalog('en')
    for (const locale of LOCALES) {
      const catalog = readCatalog(locale)
      for (const key of KEYS) {
        const enValue = getValue(english, key)
        const localeValue = getValue(catalog, key)
        expect(repairTranslatedValue({ key, enValue, localeValue, locale })).toBe(localeValue)
      }
    }
  })

  it('uses the macOS Full Disk Access labels in Korean and Chinese', () => {
    expect(
      getValue(readCatalog('ko'), 'auto.components.settings.DeveloperPermissionsPane.c566bca278')
    ).toBe('전체 디스크 접근 권한')
    expect(
      getValue(readCatalog('zh'), 'auto.components.settings.DeveloperPermissionsPane.c566bca278')
    ).toBe('完全磁盘访问权限')
  })
})
