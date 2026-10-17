// Simplified → Traditional Chinese (Taiwan) conversion for zh-Hant.json.
//
// zh-Hant is derived from the Simplified catalog, not translated from English,
// for two reasons: the Simplified catalog already carries reviewed Orca
// terminology that a fresh English translation would have to rediscover, and a
// character conversion cannot regress a term that catalog settled.
//
// OpenCC supplies the conversion. `cn → twp` is the Taiwan-standard profile with
// phrase-level vocabulary (軟件→軟體, 默認→預設, 光標→游標), which is what a
// Traditional reader expects; the plain `tw` profile would only remap characters
// and leave 設置/保存/裡面 looking mainland.
//
// One pass only, then the reviewed corrections. `twp`'s phrase dictionary is not
// idempotent, and iterating to a fixed point makes the output WORSE in two
// measured cases: it turns the correct Taiwan 游標 ("cursor") into 遊標, and 程序
// ("program") into 程式 where the source meant "process" (進程→程序). Single-pass
// `twp` is right on both; the residual misses are corrected explicitly in
// locale-zht-value-overrides.mjs so every change from `twp` is reviewable.
import * as OpenCC from 'opencc-js'

import { ZHT_PHRASE_FIXES, ZHT_SOURCE_CONDITIONAL_FIXES } from './locale-zht-value-overrides.mjs'

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' })
// Pure character map, no phrase matching — the context-free answer to "is this
// glyph Simplified-only?". The Taiwan profile's phrase dictionary is what makes
// a conversion judgment context-dependent; this is not a conversion, just a
// test of the glyph.
const toTraditionalCharacters = OpenCC.Converter({ from: 'cn', to: 'tw' })

// Characters the Simplified script merged into one glyph that Traditional still
// writes as two distinct ones. Seeing them in a Traditional catalog is NOT
// evidence of a skipped conversion: 批准 (approve), 控制台 (console), 里程碑
// (milestone), 上游 (upstream) and 白雲 (cloud) are all correct as written.
// Only the char map knows the other reading exists, so it must be told these
// glyphs are legitimate rather than left to flag every one of them.
const SHARED_WITH_TRADITIONAL = new Set([
  '准',
  '台',
  '里',
  '游',
  '云',
  '系',
  '只',
  '面',
  '制',
  '板',
  '后'
])

/**
 * True when the glyph exists only in Simplified, so seeing it in a Traditional
 * catalog means the conversion skipped it.
 *
 * Why not "the phrase converter would change it": that converter is not
 * idempotent, so re-running it on already-correct Traditional text reports many
 * false positives (it rewrites the correct 游標 to 遊標). Comparing the single
 * glyph, minus the merged-glyph exceptions above, is stable under re-application.
 */
export function isSimplifiedOnly(character) {
  return !SHARED_WITH_TRADITIONAL.has(character) && toTraditionalCharacters(character) !== character
}

/**
 * Traditional value for one Simplified value: OpenCC, then the reviewed rules.
 *
 * The Simplified value is the disambiguator for rules where `twp` collapses two
 * distinct source words into one output (see ZHT_SOURCE_CONDITIONAL_FIXES).
 */
export function convertValueToTraditional(simplifiedValue) {
  let result = toTraditional(simplifiedValue)
  for (const [from, to] of ZHT_PHRASE_FIXES) {
    result = result.replaceAll(from, to)
  }
  for (const { source, from, to } of ZHT_SOURCE_CONDITIONAL_FIXES) {
    if (simplifiedValue.includes(source)) {
      result = result.replaceAll(from, to)
    }
  }
  return result
}

export function collectStringLeaves(value, prefix = '', leaves = []) {
  if (typeof value === 'string') {
    leaves.push({ key: prefix, value })
    return leaves
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return leaves
  }
  for (const [key, child] of Object.entries(value)) {
    collectStringLeaves(child, prefix ? `${prefix}.${key}` : key, leaves)
  }
  return leaves
}

/**
 * Rebuilds a catalog with every string converted, mirroring the input's shape and
 * key order so the generated file diffs only on the values that actually changed.
 * `convert` receives the string and its dotted key path, so a per-key override
 * can be applied alongside a per-value one.
 */
export function convertCatalogLeaves(value, convert, prefix = '') {
  if (typeof value === 'string') {
    return convert(value, prefix)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = convertCatalogLeaves(child, convert, prefix ? `${prefix}.${key}` : key)
  }
  return result
}
