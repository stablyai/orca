import { describe, expect, it } from 'vitest'
import { insertUnpinnedTab } from './moved-pane-tab-order'

describe('placing a moved pane tab in the host order', () => {
  it('never puts the new tab ahead of a tab pinned after the index was chosen', () => {
    // The client asked for the gap before A; A was pinned to the front while the commit ran.
    expect(insertUnpinnedTab(['A', 'B', 'C'], 'NEW', 0, new Set(['A']))).toEqual([
      'A',
      'NEW',
      'B',
      'C'
    ])
  })

  it('keeps a legal requested gap and appends without one', () => {
    expect(insertUnpinnedTab(['A', 'B', 'C'], 'NEW', 2, new Set(['A']))).toEqual([
      'A',
      'B',
      'NEW',
      'C'
    ])
    expect(insertUnpinnedTab(['A', 'B'], 'NEW', undefined, new Set())).toEqual(['A', 'B', 'NEW'])
    expect(insertUnpinnedTab(['A', 'B'], 'NEW', 9, new Set(['A', 'B']))).toEqual(['A', 'B', 'NEW'])
  })
})
