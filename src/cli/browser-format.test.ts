import { describe, expect, it } from 'vitest'
import { formatTabListWithProfiles } from './browser-format'

describe('formatTabListWithProfiles', () => {
  it('marks parked tabs and leaves resident ones unmarked', () => {
    const output = formatTabListWithProfiles(
      {
        tabs: [
          { browserPageId: 'a', index: 0, url: 'https://a.test/', title: 'A', active: true },
          {
            browserPageId: 'b',
            index: 1,
            url: 'https://b.test/',
            title: 'B',
            active: false,
            parked: true
          }
        ]
      },
      false
    )

    expect(output).toBe('* [0] a  A — https://a.test/\n  [1] b  B — https://b.test/  (parked)')
  })
})
