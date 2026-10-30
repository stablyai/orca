import { describe, expect, it } from 'vitest'
import { formatTabList } from './browser-format'

describe('formatTabList', () => {
  it('marks restored tabs that have not loaded', () => {
    const text = formatTabList({
      tabs: [
        {
          browserPageId: 'p1',
          index: 0,
          url: 'https://a.test/',
          title: 'A',
          active: false,
          loaded: false
        },
        {
          browserPageId: 'p2',
          index: 1,
          url: 'https://b.test/',
          title: 'B',
          active: true,
          loaded: true
        },
        { browserPageId: 'p3', index: 2, url: 'https://c.test/', title: 'C', active: false }
      ]
    })
    expect(text.split('\n')).toEqual([
      '  [0] p1  A — https://a.test/  (not loaded)',
      '* [1] p2  B — https://b.test/',
      '  [2] p3  C — https://c.test/'
    ])
  })
})
