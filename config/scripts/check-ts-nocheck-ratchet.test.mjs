import { describe, expect, it } from 'vitest'

import { diffBaseline, hasTsNoCheck, parseBaseline } from './check-ts-nocheck-ratchet.mjs'

describe('hasTsNoCheck', () => {
  it('detects a line-comment form', () => {
    expect(hasTsNoCheck('// @ts-nocheck\nexport const a = 1\n')).toBe(true)
  })

  it('detects a block-comment form', () => {
    expect(hasTsNoCheck('/* @ts-nocheck */\nexport const a = 1\n')).toBe(true)
  })

  it('detects the no-space form', () => {
    expect(hasTsNoCheck('//@ts-nocheck\nexport const a = 1\n')).toBe(true)
  })

  it('detects a directive with a -- Why reason', () => {
    expect(
      hasTsNoCheck(
        '// @ts-nocheck -- Why: mechanically split, covered by AST tests.\nimport x from "y"\n'
      )
    ).toBe(true)
  })

  it('allows blank lines and other leading comments before the directive', () => {
    const src =
      '\n// Copyright notice.\n\n/* another leading comment */\n// @ts-nocheck\nexport const a = 1\n'
    expect(hasTsNoCheck(src)).toBe(true)
  })

  it('does not match once a statement has started', () => {
    const src = 'export const a = 1\n// @ts-nocheck\n'
    expect(hasTsNoCheck(src)).toBe(false)
  })

  it('does not match inside a string literal', () => {
    const src = 'export const a = "// @ts-nocheck"\n'
    expect(hasTsNoCheck(src)).toBe(false)
  })

  it('returns false for ordinary source', () => {
    expect(hasTsNoCheck('export function f() {\n  return 42\n}\n')).toBe(false)
  })
})

describe('parseBaseline', () => {
  it('drops comments and blank lines', () => {
    const b = parseBaseline('# header\n\nsrc/a.ts\nsrc/b.ts\n')
    expect(b).toEqual(new Set(['src/a.ts', 'src/b.ts']))
  })
})

describe('diffBaseline', () => {
  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(
      ['src/b.ts', 'src/c.ts'],
      new Set(['src/a.ts', 'src/b.ts'])
    )
    expect(added).toEqual(['src/c.ts']) // new suppression
    expect(stale).toEqual(['src/a.ts']) // suppression removed
  })

  it('is clean when current matches baseline', () => {
    const { added, stale } = diffBaseline(['src/a.ts'], new Set(['src/a.ts']))
    expect(added).toEqual([])
    expect(stale).toEqual([])
  })
})
