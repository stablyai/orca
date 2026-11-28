import { describe, expect, it } from 'vitest'
import { countRawTabListReads, unexplainedRows } from './check-raw-tab-list-read-ratchet.mjs'

describe('raw tab list reads', () => {
  it.each([
    ['an iteration', 'for (const p of this.ptysById.values()) {}'],
    ['an optional iteration', 'this.ptysById?.values()'],
    ['an optional size read', 'const n = this.ptysById?.size'],
    ['a map off a call', 'for (const [id, p] of getRuntime().ptysById) {}'],
    ['a spread off a call', 'const all = [...getRuntime().ptysById]'],
    ['Array.from off a call', 'const all = Array.from(getRuntime().ptysById)'],
    ['a fallback', 'for (const [id, p] of this.ptysById ?? []) {}'],
    ['a Map copy', 'const copy = new Map(this.ptysById)'],
    ['Object.fromEntries', 'const all = Object.fromEntries(this.ptysById)'],
    ['the iterator', 'const it = this.ptysById[Symbol.iterator]()'],
    ['a local alias', 'const m = this.ptysById; for (const p of m.values()) {}'],
    ['the backing map', 'this.terminalIdentity.ptys.forEach(() => {})'],
    ['a source handed along', 'for (const [id, p] of this.source.ptys) {}'],
    ['the getter', 'const all = [...this.deps.getPtys()]'],
    ['a registry call', 'registry.everyPage()'],
    ['a call on the registry it returns', 'getRuntimeBrowserPageRegistry(this).everyPage(id)'],
    ['an optional registry call', 'registry?.everyPage()'],
    ['a destructured everyPage', 'const { everyPage } = registry; everyPage()'],
    ['a renamed everyPage', 'const { everyPage: all } = registry; all()']
  ])('counts %s', (_form, source) => {
    expect(countRawTabListReads(source)).toBe(1)
  })

  it('leaves reads by key and the person filters alone', () => {
    expect(
      countRawTabListReads(
        [
          'const pty = this.ptysById.get(id)',
          'this.ptysById.set(id, pty)',
          'if (this.ptysById.has(id)) {}',
          'const pages = registry.pagesOf(list, workspaceId)',
          '// for (const p of this.ptysById.values()) {}'
        ].join('\n')
      )
    ).toBe(0)
  })

  it('refuses an allowed row that gives no reason', () => {
    expect(
      unexplainedRows('1 src/main/runtime/a.ts # teardown\n2 src/main/runtime/b.ts\n')
    ).toEqual(['src/main/runtime/b.ts'])
  })
})
