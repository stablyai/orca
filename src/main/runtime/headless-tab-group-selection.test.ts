import { describe, expect, it } from 'vitest'
import { withSelectedTabs } from './headless-tab-group-selection'

describe('withSelectedTabs', () => {
  it('selects the moved tab where it lands and the survivor where it left', () => {
    const before = [{ id: 'g1', activeTabId: 'b', tabOrder: ['a', 'b'], recentTabIds: ['b', 'a'] }]
    const after = [
      { id: 'g1', tabOrder: ['a'] },
      { id: 'g2', tabOrder: ['b'] }
    ]
    expect(withSelectedTabs(before, after, 'b')).toEqual([
      { id: 'g1', activeTabId: 'a', tabOrder: ['a'], recentTabIds: ['b', 'a'] },
      { id: 'g2', activeTabId: 'b', tabOrder: ['b'] }
    ])
  })

  it('keeps a selection the move did not touch', () => {
    const before = [
      { id: 'g1', activeTabId: 'a', tabOrder: ['a', 'b'] },
      { id: 'g2', activeTabId: 'c', tabOrder: ['c'] }
    ]
    const after = [
      { id: 'g1', tabOrder: ['a'] },
      { id: 'g2', tabOrder: ['b', 'c'] }
    ]
    expect(withSelectedTabs(before, after, 'b').map((group) => group.activeTabId)).toEqual([
      'a',
      'b'
    ])
  })
})
