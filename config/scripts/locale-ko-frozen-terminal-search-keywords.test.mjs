import fs from 'node:fs'

import { describe, expect, it } from 'vitest'
import { repairTranslatedValue } from './locale-translation-policy.mjs'

// Use UI’s stopped sense for frozen/unfreeze search pair; MT’s 녹이다 (thaw ice) split recovery search terms.
const KEYS = [
  'auto.components.settings.terminal.search.88561b3499',
  'auto.components.settings.terminal.search.d4daf4f612'
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

  it('survives the canonical catalog repair policy', () => {
    const english = readCatalog('en')
    const catalog = readCatalog('ko')
    for (const key of KEYS) {
      const enValue = getValue(english, key)
      const localeValue = getValue(catalog, key)
      expect(enValue, key).toEqual(expect.any(String))
      expect(localeValue, key).toEqual(expect.any(String))
      expect(repairTranslatedValue({ key, enValue, localeValue, locale: 'ko' }), key).toBe(
        localeValue
      )
    }
  })
})
