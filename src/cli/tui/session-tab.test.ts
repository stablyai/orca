import { describe, expect, it } from 'vitest'
import { tabGlyph, toSessionTabs } from './session-tab'

describe('toSessionTabs', () => {
  it('maps a ready terminal tab, keeping its readAnsi handle', () => {
    const [tab] = toSessionTabs('wt', [
      { type: 'terminal', id: 't1', title: 'shell', status: 'ready', terminal: 'term_abc' }
    ])
    expect(tab).toEqual({
      worktreeId: 'wt',
      id: 't1',
      kind: 'terminal',
      title: 'shell',
      terminalHandle: 'term_abc',
      relativePath: null,
      url: null
    })
  })

  it('leaves a pending terminal tab without a handle', () => {
    const [tab] = toSessionTabs('wt', [{ type: 'terminal', id: 't2', status: 'pending-handle' }])
    expect(tab.terminalHandle).toBeNull()
  })

  it('maps file and markdown tabs to their source path', () => {
    const tabs = toSessionTabs('wt', [
      { type: 'file', id: 'f1', title: 'a.ts', relativePath: 'src/a.ts' },
      { type: 'markdown', id: 'm1', title: 'doc', sourceRelativePath: 'docs/x.md' }
    ])
    expect(tabs.map((t) => [t.kind, t.relativePath])).toEqual([
      ['file', 'src/a.ts'],
      ['markdown', 'docs/x.md']
    ])
  })

  it('maps a browser tab to its url and drops tabs without an id', () => {
    const tabs = toSessionTabs('wt', [
      { type: 'browser', id: 'b1', title: 'site', url: 'https://x' },
      { type: 'file', title: 'noid' }
    ])
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ kind: 'browser', url: 'https://x' })
  })
})

describe('tabGlyph', () => {
  it('gives each kind a distinct single-width glyph', () => {
    const glyphs = ['terminal', 'file', 'markdown', 'browser'].map((k) => tabGlyph(k as never))
    expect(new Set(glyphs).size).toBe(4)
    expect(glyphs.every((g) => g.length === 1)).toBe(true)
  })
})
