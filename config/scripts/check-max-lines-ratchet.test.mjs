import { describe, expect, it } from 'vitest'

import {
  collectMobileBumps,
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
      'mobile-config app/h/*/tasks.tsx',
      'mobile-config scripts/mock-server.ts'
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
    const b = parseBaseline('# header\n\ninline a.ts\nmobile-config x/*.tsx\n')
    expect(b).toEqual(new Set(['inline a.ts', 'mobile-config x/*.tsx']))
  })
})

describe('diffBaseline', () => {
  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(
      ['inline b.ts', 'inline c.ts'],
      new Set(['inline a.ts', 'inline b.ts'])
    )
    expect(added).toEqual(['inline c.ts']) // new bypass
    expect(stale).toEqual(['inline a.ts']) // suppression removed
  })

  it('is clean when current matches baseline', () => {
    const { added, stale } = diffBaseline(['inline a.ts'], new Set(['inline a.ts']))
    expect(added).toEqual([])
    expect(stale).toEqual([])
  })
})
