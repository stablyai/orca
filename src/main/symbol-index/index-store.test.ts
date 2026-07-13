import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '../../shared/symbol-index'
import { SymbolIndexStore } from './index-store'

const def = (name: string, path: string, line: number): SymbolDef => ({
  name,
  kind: 'function',
  path,
  line,
  column: 1
})

describe('SymbolIndexStore', () => {
  it('finds symbols by exact name across files, ordered by path then line', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/b.ts', [def('foo', '/b.ts', 10)])
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5), def('bar', '/a.ts', 8)])
    expect(s.find('w1', 'foo')).toEqual([def('foo', '/a.ts', 5), def('foo', '/b.ts', 10)])
    expect(s.find('w1', 'bar')).toEqual([def('bar', '/a.ts', 8)])
    expect(s.find('w1', 'nope')).toEqual([])
  })

  it('setFileSymbols replaces prior defs for the same file', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5)])
    s.setFileSymbols('w1', '/a.ts', [def('baz', '/a.ts', 7)])
    expect(s.find('w1', 'foo')).toEqual([])
    expect(s.find('w1', 'baz')).toEqual([def('baz', '/a.ts', 7)])
  })

  it('removeFile and clearWorktree drop entries; worktrees are isolated', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5)])
    s.setFileSymbols('w2', '/a.ts', [def('foo', '/a.ts', 9)])
    s.removeFile('w1', '/a.ts')
    expect(s.find('w1', 'foo')).toEqual([])
    expect(s.find('w2', 'foo')).toEqual([def('foo', '/a.ts', 9)])
    expect(s.hasWorktree('w2')).toBe(true)
    s.clearWorktree('w2')
    expect(s.hasWorktree('w2')).toBe(false)
  })
})
