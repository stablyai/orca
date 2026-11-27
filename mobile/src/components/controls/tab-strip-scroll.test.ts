import { describe, expect, it } from 'vitest'
import {
  buildTabStripLayouts,
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  type TabStripEdgeHint
} from './tab-strip-scroll'

describe('buildTabStripLayouts', () => {
  it('recomputes horizontal offsets from current tab order so a left-shifted working tab clears the right edge hint without re-measuring', () => {
    const widths = new Map([
      ['a', 128],
      ['b', 128],
      ['c', 128],
      ['d', 128]
    ])
    const states = new Map<string, TabStripEdgeHint>([['d', 'working']])
    const viewportWidth = 280

    const initialHidden = resolveTabStripHiddenTabs({
      layouts: buildTabStripLayouts(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        widths,
        12
      ),
      viewportWidth,
      currentOffset: 0
    })
    expect(initialHidden.right).toContain('d')
    expect(resolveTabStripEdgeHint(initialHidden.right, states)).toBe('working')

    // Removing preceding tabs moves `d` into the visible viewport while its own width stays 128.
    const narrowedHidden = resolveTabStripHiddenTabs({
      layouts: buildTabStripLayouts([{ id: 'd' }, { id: 'b' }], widths, 12),
      viewportWidth,
      currentOffset: 0
    })
    expect(narrowedHidden.right).not.toContain('d')
    expect(resolveTabStripEdgeHint(narrowedHidden.right, states)).toBeNull()

    // Reordering `d` to the front likewise clears its right edge hint without needing a ResizeObserver event.
    const reorderedHidden = resolveTabStripHiddenTabs({
      layouts: buildTabStripLayouts(
        [{ id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
        widths,
        12
      ),
      viewportWidth,
      currentOffset: 0
    })
    expect(reorderedHidden.right).toEqual(['b', 'c'])
    expect(resolveTabStripEdgeHint(reorderedHidden.right, states)).toBeNull()
  })
})
