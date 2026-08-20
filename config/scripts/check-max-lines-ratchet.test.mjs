import { describe, expect, it } from 'vitest'

import {
  collectMobileBumps,
  countNonBlankNonCommentLines,
  defaultLimitForPath,
  diffBaseline,
  hasMaxLinesDisable,
  parseBaseline
} from './check-max-lines-ratchet.mjs'

describe('hasMaxLinesDisable', () => {
  it('detects a bare block disable', () => {
    expect(hasMaxLinesDisable('/* eslint-disable max-lines */\nexport const a = 1\n')).toBe(true)
  })

  it('detects the oxlint spelling', () => {
    expect(hasMaxLinesDisable('/* oxlint-disable max-lines */\n')).toBe(true)
  })

  it('detects a disable with a -- Why reason', () => {
    expect(hasMaxLinesDisable('/* eslint-disable max-lines -- Why: one owner. */\n')).toBe(true)
  })

  it('detects a multi-line block where the reason wraps', () => {
    const src =
      '/* eslint-disable max-lines -- Why: this contract is\n * intentionally centralized. */\nimport x from "y"\n'
    expect(hasMaxLinesDisable(src)).toBe(true)
  })

  it('detects max-lines inside a compound rule list', () => {
    expect(hasMaxLinesDisable('/* eslint-disable no-control-regex, max-lines -- Why: x */\n')).toBe(
      true
    )
    expect(hasMaxLinesDisable('/* eslint-disable max-lines, no-control-regex */\n')).toBe(true)
  })

  it('detects a line-scoped disable', () => {
    expect(hasMaxLinesDisable('const a = 1 // eslint-disable-line max-lines\n')).toBe(true)
  })

  it('ignores a disable for an unrelated rule', () => {
    expect(hasMaxLinesDisable('/* eslint-disable no-console */\n')).toBe(false)
  })

  it('does not treat "max-lines" appearing only in the reason text as a suppression', () => {
    // max-lines is after the `--`, so it is prose, not a suppressed rule.
    expect(
      hasMaxLinesDisable('/* eslint-disable no-console -- we could hit max-lines later */\n')
    ).toBe(false)
  })

  it('returns false for ordinary source', () => {
    expect(hasMaxLinesDisable('export function f() {\n  return 42\n}\n')).toBe(false)
  })
})

describe('defaultLimitForPath', () => {
  it('uses 800 for tests, 400 for tsx, 600 for mjs, 300 otherwise', () => {
    expect(defaultLimitForPath('a/b.test.ts')).toBe(800)
    expect(defaultLimitForPath('a/b.spec.tsx')).toBe(800)
    expect(defaultLimitForPath('a/b.tsx')).toBe(400)
    expect(defaultLimitForPath('a/b.mjs')).toBe(600)
    expect(defaultLimitForPath('a/b.ts')).toBe(300)
  })
})

describe('countNonBlankNonCommentLines', () => {
  it('skips blank lines and whitespace-only lines', () => {
    expect(countNonBlankNonCommentLines('const a = 1\n\n   \nconst b = 2\n')).toBe(2)
  })

  it('skips whole-line // comments but keeps trailing ones', () => {
    expect(countNonBlankNonCommentLines('// note\nconst a = 1 // why\n')).toBe(1)
  })

  it('skips multi-line block comments including the banner form', () => {
    const src = '/* eslint-disable max-lines -- Why: x */\n/*\n * prose\n */\nconst a = 1\n'
    expect(countNonBlankNonCommentLines(src)).toBe(1)
  })

  it('counts code that follows a block comment close on the same line', () => {
    expect(countNonBlankNonCommentLines('/* c */ const a = 1\n')).toBe(1)
  })

  it('does not treat a URL inside a string as a comment', () => {
    expect(countNonBlankNonCommentLines('const u = "https://example.com"\n')).toBe(1)
  })

  it('does not treat comment markers inside strings as comments', () => {
    expect(countNonBlankNonCommentLines("const s = '/* not a comment */'\nconst b = 2\n")).toBe(2)
  })

  it('counts every line of a multi-line template literal', () => {
    expect(countNonBlankNonCommentLines('const t = `a\nb\nc`\n')).toBe(3)
  })

  it('does not let an escaped backtick end a template early', () => {
    expect(countNonBlankNonCommentLines('const t = `a\\`b\n// still template\n`\n')).toBe(3)
  })

  it('returns 0 for an all-comment file', () => {
    expect(countNonBlankNonCommentLines('// a\n// b\n/* c\n   d */\n')).toBe(0)
  })
})

describe('collectMobileBumps', () => {
  it('captures only overrides whose max exceeds the default for the glob', () => {
    const cfg = JSON.stringify({
      overrides: [
        { files: ['app/h/*/tasks.tsx'], rules: { 'max-lines': ['error', { max: 14682 }] } }, // bump (>400)
        {
          files: ['src/terminal/TerminalWebView.tsx'],
          rules: { 'max-lines': ['error', { max: 379 }] }
        }, // stricter (<400), skip
        { files: ['scripts/mock-server.ts'], rules: { 'max-lines': ['error', { max: 407 }] } } // bump (>300)
      ]
    })
    expect(collectMobileBumps(cfg)).toEqual([
      { key: 'mobile-config app/h/*/tasks.tsx', count: 14682 },
      { key: 'mobile-config scripts/mock-server.ts', count: 407 }
    ])
  })

  it('freezes the declared cap so raising a bump is caught as growth', () => {
    const bump = (max) =>
      JSON.stringify({
        overrides: [{ files: ['a.tsx'], rules: { 'max-lines': ['error', { max }] } }]
      })
    const baseline = parseBaseline('mobile-config a.tsx max=500\n')
    expect(diffBaseline(collectMobileBumps(bump(500)), baseline).grown).toEqual([])
    expect(diffBaseline(collectMobileBumps(bump(900)), baseline).grown).toEqual([
      { key: 'mobile-config a.tsx', budget: 500, count: 900 }
    ])
  })

  it('ignores overrides without a max-lines rule', () => {
    const cfg = JSON.stringify({
      overrides: [{ files: ['a.tsx'], rules: { 'no-console': 'off' } }]
    })
    expect(collectMobileBumps(cfg)).toEqual([])
  })
})

describe('parseBaseline', () => {
  it('drops comments and blank lines', () => {
    const b = parseBaseline('# header\n\ninline a.ts max=10\nmobile-config x/*.tsx\n')
    expect([...b.keys()]).toEqual(['inline a.ts', 'mobile-config x/*.tsx'])
  })

  it('reads the line budget and leaves legacy rows unbudgeted', () => {
    const b = parseBaseline('inline a.ts max=1234\ninline legacy.ts\n')
    expect(b.get('inline a.ts')).toBe(1234)
    expect(b.get('inline legacy.ts')).toBeNull()
  })
})

describe('diffBaseline', () => {
  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(
      [
        { key: 'inline b.ts', count: 10 },
        { key: 'inline c.ts', count: 10 }
      ],
      parseBaseline('inline a.ts max=10\ninline b.ts max=10\n')
    )
    expect(added).toEqual(['inline c.ts']) // new bypass
    expect(stale).toEqual(['inline a.ts']) // suppression removed
  })

  it('is clean when current matches baseline', () => {
    const { added, stale, grown, shrunk } = diffBaseline(
      [{ key: 'inline a.ts', count: 10 }],
      parseBaseline('inline a.ts max=10\n')
    )
    expect(added).toEqual([])
    expect(stale).toEqual([])
    expect(grown).toEqual([])
    expect(shrunk).toEqual([])
  })

  it('flags a grandfathered file that grew past its frozen budget', () => {
    const { grown } = diffBaseline(
      [{ key: 'inline big.ts', count: 41 }],
      parseBaseline('inline big.ts max=40\n')
    )
    expect(grown).toEqual([{ key: 'inline big.ts', budget: 40, count: 41 }])
  })

  it('flags a shrunk file so the win can be re-locked', () => {
    const { shrunk, grown } = diffBaseline(
      [{ key: 'inline big.ts', count: 30 }],
      parseBaseline('inline big.ts max=40\n')
    )
    expect(grown).toEqual([])
    expect(shrunk).toEqual([{ key: 'inline big.ts', budget: 40, count: 30 }])
  })

  it('orders grown entries by how much they overshot', () => {
    const { grown } = diffBaseline(
      [
        { key: 'inline small.ts', count: 11 },
        { key: 'inline huge.ts', count: 500 }
      ],
      parseBaseline('inline small.ts max=10\ninline huge.ts max=100\n')
    )
    expect(grown.map((g) => g.key)).toEqual(['inline huge.ts', 'inline small.ts'])
  })

  it('never flags growth for a legacy row that has no budget yet', () => {
    const { grown, shrunk } = diffBaseline(
      [{ key: 'inline legacy.ts', count: 9999 }],
      parseBaseline('inline legacy.ts\n')
    )
    expect(grown).toEqual([])
    expect(shrunk).toEqual([])
  })

  it('never flags an entry whose measurement is unavailable', () => {
    const { grown, shrunk } = diffBaseline(
      [{ key: 'inline gone.ts', count: null }],
      parseBaseline('inline gone.ts max=100\n')
    )
    expect(grown).toEqual([])
    expect(shrunk).toEqual([])
  })
})
