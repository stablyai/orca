import fs from 'node:fs'

import { describe, expect, it } from 'vitest'
import { repairTranslatedValue } from './locale-translation-policy.mjs'

// The frozen-terminal recovery entry is searchable only if both halves of the pair use the
// UI's "stopped" sense; MT rendered `unfreeze` as 녹이다 (thawing ice), splitting them.
const PAIR = [
  { key: 'auto.components.settings.terminal.search.88561b3499', enValue: 'frozen', ko: '정지됨' },
  {
    key: 'auto.components.settings.terminal.search.d4daf4f612',
    enValue: 'unfreeze',
    ko: '정지 해제'
  }
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

describe('Korean frozen-terminal settings search keywords', () => {
  it('repairs the machine-translated unfreeze keyword', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.terminal.search.d4daf4f612',
        enValue: 'unfreeze',
        localeValue: '녹이다',
        locale: 'ko'
      })
    ).toBe('정지 해제')
  })

  it('ships the pair in the Korean catalog', () => {
    const catalog = readCatalog('ko')
    for (const { key, ko } of PAIR) {
      expect(getValue(catalog, key), key).toBe(ko)
    }
  })

  it('survives the canonical catalog repair policy', () => {
    const english = readCatalog('en')
    const catalog = readCatalog('ko')
    for (const { key, enValue } of PAIR) {
      expect(getValue(english, key), key).toBe(enValue)
      const localeValue = getValue(catalog, key)
      expect(repairTranslatedValue({ key, enValue, localeValue, locale: 'ko' }), key).toBe(
        localeValue
      )
    }
  })
})
