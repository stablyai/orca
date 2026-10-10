import { describe, expect, it } from 'vitest'

import { collectLiteralKeys, isKeyReferenced } from './find-orphaned-catalog-keys.mjs'

const sets = ({ referenced = [], literals = [], english = [] } = {}) => ({
  referenced: new Set(referenced),
  literals: new Set(literals),
  english: new Set(english)
})

describe('isKeyReferenced', () => {
  it('accepts a key extraction resolved', () => {
    expect(isKeyReferenced('a.b', sets({ referenced: ['a.b'] }))).toBe(true)
  })

  // Why: extraction sees neither a key held in a data structure nor one passed
  // as a variable, so the literal scan is the only evidence those are live.
  it('accepts a key extraction missed but a source literal spells out', () => {
    expect(isKeyReferenced('a.b', sets({ literals: ['a.b'] }))).toBe(true)
  })

  it('reports a key no source mentions at all', () => {
    expect(isKeyReferenced('a.b', sets({ referenced: ['a.c'], literals: ['a.d'] }))).toBe(false)
  })

  // Why: i18next appends the CLDR category at runtime, so `…count_one` appears
  // in no source file. Judging it directly retires every plural in the catalog.
  it.each(['zero', 'one', 'two', 'few', 'many', 'other'])(
    'keeps a _%s variant whose base key is referenced',
    (category) => {
      expect(isKeyReferenced(`a.count_${category}`, sets({ referenced: ['a.count'] }))).toBe(true)
    }
  )

  it('keeps a plural variant whose base key only the catalog carries', () => {
    expect(isKeyReferenced('a.count_one', sets({ english: ['a.count'] }))).toBe(true)
  })

  it('reports a plural variant whose base key is itself unreachable', () => {
    expect(isKeyReferenced('a.count_one', sets({ referenced: ['a.other'] }))).toBe(false)
  })

  // Why: the suffix rule must not turn an ordinary key into a plural. Stripping
  // `_one` here would leave `a.b`, which nothing references either way — but a
  // key ending in a non-CLDR word has no base to fall back on at all.
  it('gives a key ending in a non-CLDR word no base-key fallback', () => {
    expect(isKeyReferenced('a.b_single', sets({ referenced: ['a.b'], english: ['a.b'] }))).toBe(
      false
    )
  })
})

describe('collectLiteralKeys', () => {
  it('finds a key held in a data structure', () => {
    expect([...collectLiteralKeys("const tabs = [{ key: 'settings.appearance' }]")]).toEqual([
      'settings.appearance'
    ])
  })

  it.each(["'a.bcdefg'", '"a.bcdefg"', '`a.bcdefg`'])('reads the %s quoting form', (literal) => {
    expect(collectLiteralKeys(`translate(${literal})`).has('a.bcdefg')).toBe(true)
  })

  // Why: a catalog key always carries a dot, so requiring one keeps the scan
  // from drowning in ordinary strings and pinning keys nothing references.
  it.each(['sonnet', 'pnpm install', 'a.b', 'Some sentence.'])(
    'ignores the non-key literal %p',
    (text) => {
      expect(collectLiteralKeys(`const x = '${text}'`).size).toBe(0)
    }
  )

  it('accumulates across calls into one set', () => {
    const found = collectLiteralKeys("t('first.keyname')")
    collectLiteralKeys("t('second.keyname')", found)
    expect([...found].sort()).toEqual(['first.keyname', 'second.keyname'])
  })
})
