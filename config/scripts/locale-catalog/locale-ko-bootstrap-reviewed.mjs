import fs from 'node:fs/promises'

import { LOCALE_KEY_OVERRIDES } from './locale-key-overrides.mjs'
import { repairTranslatedValue, shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

function signature(text, key) {
  const tokens = [...text.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]).sort()
  if (/[{}]/.test(text.replace(/{{\s*[^{}]+?\s*}}/g, ''))) {
    throw new Error(`${key}: invalid interpolation`)
  }
  const tags = []
  const stack = []
  for (const match of text.matchAll(/<[^>]*>/g)) {
    const tag = /^<(\/?)([A-Za-z][\w-]*)>$/.exec(match[0])
    if (!tag) {
      throw new Error(`${key}: invalid rich tag`)
    }
    if (tag[1]) {
      if (stack.pop() !== tag[2]) {
        throw new Error(`${key}: unbalanced rich tag`)
      }
    } else {
      stack.push(tag[2])
      tags.push(tag[2])
    }
  }
  if (stack.length || /<[A-Za-z/]/.test(text.replace(/<[^>]*>/g, ''))) {
    throw new Error(`${key}: unbalanced rich tag`)
  }
  return JSON.stringify([tokens, tags.sort()])
}

export async function reviewedKoreanLeaves(leaves) {
  const rows = JSON.parse(
    await fs.readFile(new URL('./locale-ko-bootstrap-reviewed.json', import.meta.url), 'utf8')
  )
  if (!Array.isArray(rows)) {
    throw new Error('Korean bootstrap rows must be an array')
  }
  const current = new Map(leaves.map((leaf) => [leaf.key, leaf.value]))
  const active = new Map()
  const seen = new Set()
  for (const row of rows) {
    const { key, en, ko } = row ?? {}
    if (![key, en, ko].every((value) => typeof value === 'string' && value.trim())) {
      throw new Error(`Invalid Korean bootstrap row: ${key ?? '(missing key)'}`)
    }
    if (seen.has(key)) {
      throw new Error(`${key}: duplicate Korean bootstrap row`)
    }
    seen.add(key)
    if (signature(en, key) !== signature(ko, key)) {
      throw new Error(`${key}: interpolation or rich tags differ`)
    }
    if (current.get(key) !== en) {
      console.warn(`Stale Korean bootstrap row: ${key}`)
      continue
    }
    if (LOCALE_KEY_OVERRIDES[key]?.ko || shouldPreserveEnglishValue(en, key)) {
      continue
    }
    if (repairTranslatedValue({ key, enValue: en, localeValue: ko, locale: 'ko' }) !== ko) {
      throw new Error(`${key}: Korean bootstrap value conflicts with translation policy`)
    }
    active.set(key, ko)
  }
  return active
}
