import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectLiteralKeys,
  collectSourceFiles,
  findOrphanedKeys,
  isKeyReferenced
} from './verify-localization-orphans.mjs'

const sets = ({ referenced = [], literals = [] } = {}) => ({
  referenced: new Set(referenced),
  literals: new Set(literals)
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

  it('keeps a plural variant whose base key only a source literal spells out', () => {
    expect(isKeyReferenced('a.count_one', sets({ literals: ['a.count'] }))).toBe(true)
  })

  // Why: a base key no source reaches cannot make its variants live, so the
  // variants surface in the same pass instead of after the base key is pruned.
  it('reports a plural variant whose base key is itself unreachable', () => {
    expect(isKeyReferenced('a.count_one', sets({ referenced: ['a.other'] }))).toBe(false)
  })

  // Why: the suffix rule must not turn an ordinary key into a plural. Stripping
  // `_one` here would leave `a.b`, which nothing references either way — but a
  // key ending in a non-CLDR word has no base to fall back on at all.
  it('gives a key ending in a non-CLDR word no base-key fallback', () => {
    expect(isKeyReferenced('a.b_single', sets({ referenced: ['a.b'] }))).toBe(false)
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
  it.each(['sonnet', 'pnpm install', 'Some sentence.', 'a.', '.b', '1.2'])(
    'ignores the non-key literal %p',
    (text) => {
      expect(collectLiteralKeys(`const x = '${text}'`).size).toBe(0)
    }
  )

  // Why: a short key is still a key. The scan once required seven characters,
  // which would have reported a live `ui.get` held in a data structure.
  it.each(['a.b', 'ui.get'])('accepts the short key %p', (text) => {
    expect([...collectLiteralKeys(`const x = { key: '${text}' }`)]).toEqual([text])
  })

  it('accumulates across calls into one set', () => {
    const found = collectLiteralKeys("t('first.keyname')")
    collectLiteralKeys("t('second.keyname')", found)
    expect([...found].sort()).toEqual(['first.keyname', 'second.keyname'])
  })
})

describe('collectSourceFiles', () => {
  let root

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('scans a checkout that has no mobile app', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orphan-roots-'))
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'tabs.ts'), '')

    expect(await collectSourceFiles(root)).toEqual([path.join(root, 'src', 'tabs.ts')])
  })

  // Why: a root the walk cannot read contributes no literals, so every key
  // named only there would be reported as safe to delete. Stop instead.
  it('fails when a required source root cannot be read', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orphan-roots-'))
    await fs.mkdir(path.join(root, 'mobile'))

    await expect(collectSourceFiles(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('findOrphanedKeys with a supplied extraction', () => {
  let root

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  // Why: the extraction gate hands in the keys its own AST pass found. That
  // must skip the second extraction — this fixture has no node_modules, so a
  // real extract call would throw instead of returning.
  it('judges the catalog against the supplied keys and the source literals', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-orphan-fixture-'))
    const locales = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales')
    await fs.mkdir(locales, { recursive: true })
    await fs.writeFile(
      path.join(locales, 'en.json'),
      JSON.stringify({ menu: { extracted: 'A', tabledKey: 'B', stranded: 'C' } })
    )
    await fs.writeFile(
      path.join(root, 'src', 'tabs.ts'),
      "export const tabs = [{ key: 'menu.tabledKey' }]\n"
    )
    // A test naming the key must not keep it alive.
    await fs.writeFile(
      path.join(root, 'src', 'tabs.test.ts'),
      "expect(translate('menu.stranded')).toBe('C')\n"
    )

    const result = await findOrphanedKeys(root, new Map([['menu.extracted', 'A']]))

    expect(result).toEqual({ total: 3, referenced: 1, orphans: ['menu.stranded'] })
  })
})
