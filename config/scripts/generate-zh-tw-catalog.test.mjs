import fs from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  convertSimplifiedCatalog,
  convertSimplifiedText,
  serializeCatalog
} from './generate-zh-tw-catalog.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

function flattenStrings(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenStrings(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

async function readCatalog(fileName) {
  return JSON.parse(await fs.readFile(path.join(LOCALES_DIR, fileName), 'utf8'))
}

describe('Traditional Chinese catalog generation', () => {
  it('uses deterministic OpenCC conversion while preserving interpolation identifiers', () => {
    expect(convertSimplifiedText('汉语 {{用户}}')).toBe('漢語 {{用户}}')
    expect(convertSimplifiedCatalog({ label: '设置', count: 2 })).toEqual({
      label: '設置',
      count: 2
    })
  })

  it('matches the committed catalog exactly', async () => {
    const simplified = await readCatalog('zh.json')
    const traditionalText = await fs.readFile(path.join(LOCALES_DIR, 'zh-TW.json'), 'utf8')

    expect(serializeCatalog(convertSimplifiedCatalog(simplified))).toBe(traditionalText)
  })

  it('keeps catalog keys and placeholders identical to Simplified Chinese', async () => {
    const simplifiedEntries = flattenStrings(await readCatalog('zh.json'))
    const traditionalEntries = flattenStrings(await readCatalog('zh-TW.json'))

    expect([...traditionalEntries.keys()]).toEqual([...simplifiedEntries.keys()])
    for (const [key, simplifiedValue] of simplifiedEntries) {
      expect(traditionalEntries.get(key)?.match(PLACEHOLDER_RE) ?? []).toEqual(
        simplifiedValue.match(PLACEHOLDER_RE) ?? []
      )
    }
  })
})
