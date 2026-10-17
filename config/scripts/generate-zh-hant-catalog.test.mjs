import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LOCALES_DIR,
  ZHT_CATALOG_FILE,
  buildZhHantCatalog,
  main,
  serializeCatalog
} from './generate-zh-hant-catalog.mjs'
import { collectStringLeaves, isSimplifiedOnly } from './zh-hant-catalog.mjs'
import { ZHT_KEY_OVERRIDES } from './locale-zht-key-overrides.mjs'

const readCatalog = (locale) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'))

const zhCatalog = readCatalog('zh')
const enCatalog = readCatalog('en')
const zhHantCatalog = readCatalog('zh-Hant')

const scratchRoots = []

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** A tree whose locales dir holds zh.json. `contents` null plants a directory instead. */
function localesTree(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-zh-hant-'))
  scratchRoots.push(root)
  const localesDir = path.join(root, LOCALES_DIR)
  if (contents === null) {
    fs.mkdirSync(path.join(localesDir, 'zh.json'), { recursive: true })
  } else {
    fs.mkdirSync(localesDir, { recursive: true })
    fs.writeFileSync(path.join(localesDir, 'zh.json'), contents)
  }
  return root
}

const emptyLocalesTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-zh-hant-'))
  scratchRoots.push(root)
  return root
}

describe('zh-Hant catalog generation', () => {
  it('stays in sync with zh.json', () => {
    // Why: zh-Hant is generated, so a Simplified edit that skips
    // `sync:zh-hant-catalog` would otherwise ship a stale Traditional catalog,
    // and the combined verifier would be the only thing to notice.
    const expected = serializeCatalog(buildZhHantCatalog({ zhCatalog }))
    const onDisk = fs.readFileSync(path.join(LOCALES_DIR, ZHT_CATALOG_FILE), 'utf8')
    expect(onDisk).toBe(expected)
  })

  it('covers exactly the keys zh.json carries', () => {
    // Why: deriving the key set from zh.json is what inherits its sparseness —
    // a key zh.json leaves to the English runtime fallback must stay absent
    // here for the same reason rather than being invented.
    const zhKeys = collectStringLeaves(zhCatalog)
      .map((leaf) => leaf.key)
      .sort()
    const zhHantKeys = collectStringLeaves(zhHantCatalog)
      .map((leaf) => leaf.key)
      .sort()
    expect(zhHantKeys).toEqual(zhKeys)
  })

  it('preserves every interpolation placeholder', () => {
    const placeholder = (value) => [...(value.match(/\{\{[^}]+\}\}/g) ?? [])].sort().join('|')
    const byKey = new Map(collectStringLeaves(zhCatalog).map((leaf) => [leaf.key, leaf.value]))
    const mismatches = collectStringLeaves(zhHantCatalog)
      .filter((leaf) => placeholder(leaf.value) !== placeholder(byKey.get(leaf.key)))
      .map((leaf) => leaf.key)
    expect(mismatches).toEqual([])
  })

  it('leaves no Simplified-only character behind', () => {
    // Why: a conversion that silently skips a word (OpenCC missed 云包) ships
    // Simplified glyphs to a Traditional reader. The check uses the pure
    // character map minus the glyphs both scripts share, and exempts the
    // language-picker endonyms — those are deliberately Simplified
    // (see locale-zht-key-overrides).
    const pinned = new Set(Object.keys(ZHT_KEY_OVERRIDES))
    const offenders = collectStringLeaves(zhHantCatalog)
      .filter((leaf) => !pinned.has(leaf.key))
      .flatMap((leaf) => {
        const simplified = [...new Set([...leaf.value].filter(isSimplifiedOnly))]
        return simplified.length > 0 ? [`${leaf.key}: ${simplified.join('')}`] : []
      })
    expect(offenders).toEqual([])
  })

  it('uses the Taiwan terms OpenCC gets wrong on its own', () => {
    const zhHant = new Map(collectStringLeaves(zhHantCatalog).map((l) => [l.key, l.value]))
    const zh = new Map(collectStringLeaves(zhCatalog).map((l) => [l.key, l.value]))

    // Permission: OpenCC emits 許可權, Taiwan says 權限.
    expect(zhHant.get('settings.chat.permissionsTitle')).toBe('新聊天的權限')
    // Cursor: OpenCC's phrase dictionary overshoots 游標 to 遊標.
    expect(zhHant.get('auto.components.settings.TerminalAppearanceSection.abcb4dd019')).toBe(
      '終端游標'
    )
    // Process: the source said 進程 (an OS process), which Taiwan calls 行程 —
    // not 程式 ("program"), which is where OpenCC's single pass lands.
    const processKeys = [...zh.keys()].filter((key) => zh.get(key)?.includes('进程'))
    expect(processKeys.length).toBeGreaterThan(0)
    for (const key of processKeys) {
      expect(zhHant.get(key), key).not.toContain('程序')
    }
  })

  // Why not folded into the leftover-character test above: that test exempts
  // glyphs both scripts legitimately share, and 云 is one of them (白雲 is
  // correct Traditional). The exemption is what lets a regression of the
  // 云包→雲包 fix pass unnoticed, so the words that motivated the rule are
  // pinned here by value instead of by glyph.
  it('converts word-forms the phrase dictionary skips', () => {
    const zhHant = new Map(collectStringLeaves(zhHantCatalog).map((l) => [l.key, l.value]))
    const zh = new Map(collectStringLeaves(zhCatalog).map((l) => [l.key, l.value]))

    const cloudKeys = [...zh.keys()].filter((key) => zh.get(key)?.includes('云'))
    expect(cloudKeys.length).toBeGreaterThan(0)
    for (const key of cloudKeys) {
      expect(zhHant.get(key), key).not.toContain('云')
    }

    // The same for the compounded 復制 that single-pass twp produced from 复制.
    const copyKeys = [...zh.keys()].filter((key) => zh.get(key)?.includes('复制'))
    expect(copyKeys.length).toBeGreaterThan(0)
    for (const key of copyKeys) {
      expect(zhHant.get(key), key).not.toContain('復制')
    }
  })

  it('keeps language-picker endonyms untranslated', () => {
    // Why: a reader switches to their own language from an interface they may
    // not read, so each language name stays in that language's own script.
    const language = zhHantCatalog.settings.appearance.language
    expect(language.chinese).toBe('中文（简体）')
    expect(language.chineseTraditional).toBe('中文（繁體）')
    expect(language.korean).toBe('한국어')
    expect(language.japanese).toBe('日本語')
  })

  it('keeps the English catalog pinned to the same picker labels', () => {
    expect(enCatalog.settings.appearance.language.chineseTraditional).toBe('中文（繁體）')
  })

  it('treats an absent zh.json as nothing to verify', async () => {
    // Why: the combined verifier runs this over synthetic fixtures that carry
    // no Simplified catalog, and those have to stay passing.
    await expect(main(emptyLocalesTree(), ['--check'])).resolves.toBe(0)
  })

  it('fails the check when zh.json cannot be parsed', async () => {
    // Why: zh.json is the only source of zh-Hant, so a malformed one used to
    // report `matches zh.json` and exit 0 without comparing anything.
    await expect(main(localesTree('{ "a": '), ['--check'])).rejects.toThrow(SyntaxError)
  })

  it('propagates zh.json read failures that are not a missing file', async () => {
    // Why: ENOENT is the one absence the generator can derive around; a
    // directory where the catalog belongs must not read as "nothing to check".
    await expect(main(localesTree(null), ['--check'])).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
