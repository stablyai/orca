import { describe, expect, it } from 'vitest'
import { tabStripStart, truncateTabLabel, visibleTailLines } from './pane-layout'
import type { SessionTab } from './session-tab'

const tab = (id: string): SessionTab => ({
  worktreeId: 'w',
  id,
  kind: 'terminal',
  title: id,
  terminalHandle: id,
  relativePath: null,
  url: null
})

describe('tabStripStart', () => {
  const tabs = ['tab0', 'tab1', 'tab2', 'tab3', 'tab4'].map(tab) // each ` ❯ tab0 ` = 8 cells

  it('keeps the start at 0 when the focused tab already fits', () => {
    expect(tabStripStart(tabs, 'tab0', 100)).toBe(0)
  })

  it('scrolls the window so a focused off-screen tab becomes visible', () => {
    // width 20 fits two 8-cell tabs; focusing the last shifts the window right.
    const start = tabStripStart(tabs, 'tab4', 20)
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThanOrEqual(4)
  })
})

describe('truncateTabLabel', () => {
  it('keeps short titles, falling back to shell for blanks', () => {
    expect(truncateTabLabel('claude')).toBe('claude')
    expect(truncateTabLabel('   ')).toBe('shell')
  })

  it('truncates long titles with an ellipsis', () => {
    expect(truncateTabLabel('a very long terminal title here', 10)).toBe('a very lo…')
  })
})

describe('visibleTailLines', () => {
  const lines = ['a', 'b', 'c', 'd', 'e']

  it('shows the last `height` lines at offset 0', () => {
    expect(visibleTailLines(lines, 2, 0)).toEqual(['d', 'e'])
  })

  it('scrolls back by the offset and clamps to available lines', () => {
    expect(visibleTailLines(lines, 2, 1)).toEqual(['c', 'd'])
    expect(visibleTailLines(lines, 10, 0)).toEqual(lines)
    expect(visibleTailLines(lines, 0, 0)).toEqual([])
  })
})
