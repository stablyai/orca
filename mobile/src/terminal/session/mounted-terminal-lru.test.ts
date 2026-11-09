import { describe, expect, it } from 'vitest'
import { nextMountedTerminalHandles } from './mounted-terminal-lru'

describe('mounted terminal LRU', () => {
  it('unmounts the least recently visible terminal when a fourth one is shown', () => {
    const live = ['a', 'b', 'c', 'd']
    let mounted: readonly string[] = []
    for (const handle of ['a', 'b', 'c', 'b', 'd']) {
      mounted = nextMountedTerminalHandles(mounted, [handle], live)
    }
    expect(mounted).toEqual(['d', 'b', 'c'])
  })

  it('keeps a split pair mounted with one more and drops closed terminals', () => {
    expect(nextMountedTerminalHandles(['c', 'b', 'a'], ['a', 'd'], ['a', 'b', 'c', 'd'])).toEqual([
      'a',
      'd',
      'c'
    ])
    expect(nextMountedTerminalHandles(['a', 'b', 'c'], ['a'], ['a', 'c'])).toEqual(['a', 'c'])
  })
})
