import { describe, expect, it } from 'vitest'
import {
  resolveTabStripEdgeHint,
  resolveTabStripHiddenTabs,
  resolveTabStripScrollOffset,
  resolveTabStripTapOffset
} from './tab-strip-scroll'

describe('resolveTabStripScrollOffset', () => {
  it('keeps the offset when the active tab is already fully visible', () => {
    expect(
      resolveTabStripScrollOffset({
        tabX: 140,
        tabWidth: 128,
        viewportWidth: 360,
        contentWidth: 800,
        currentOffset: 100
      })
    ).toBe(100)
  })

  it('scrolls left to reveal a tab off the left edge', () => {
    expect(
      resolveTabStripScrollOffset({
        tabX: 50,
        tabWidth: 128,
        viewportWidth: 360,
        contentWidth: 800,
        currentOffset: 200,
        margin: 12
      })
    ).toBe(38)
  })

  it('scrolls right to reveal a tab off the right edge', () => {
    expect(
      resolveTabStripScrollOffset({
        tabX: 640,
        tabWidth: 128,
        viewportWidth: 360,
        contentWidth: 900,
        currentOffset: 0,
        margin: 12
      })
    ).toBe(420)
  })

  it('clamps the offset to the content bounds', () => {
    expect(
      resolveTabStripScrollOffset({
        tabX: 880,
        tabWidth: 128,
        viewportWidth: 360,
        contentWidth: 900,
        currentOffset: 0
      })
    ).toBe(540)
  })

  it('returns the current offset when the viewport has not been measured', () => {
    expect(
      resolveTabStripScrollOffset({
        tabX: 100,
        tabWidth: 128,
        viewportWidth: 0,
        contentWidth: 0,
        currentOffset: 150
      })
    ).toBe(150)
  })
})

const tabs = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
const layouts = new Map(tabs.map((tab, i) => [tab.id, { x: i * 100, width: 100 }]))

describe('resolveTabStripTapOffset', () => {
  const tap = (tabId: string, currentOffset: number, viewportWidth = 300) =>
    resolveTabStripTapOffset({
      tabId,
      tabs,
      layouts,
      viewportWidth,
      contentWidth: 1000,
      currentOffset
    })

  it('brings the next tab fully into view when the tapped tab sits at the right edge', () => {
    expect(tap('2', 0)).toBe(112)
  })

  it('brings the previous tab fully into view when the tapped tab sits at the left edge', () => {
    expect(tap('5', 500)).toBe(388)
  })

  it('leaves the strip alone when the tapped tab is comfortably visible', () => {
    expect(tap('1', 70)).toBe(70)
  })

  it('waits for layout instead of jumping', () => {
    expect(tap('missing', 150)).toBe(150)
    expect(tap('3', 150, 0)).toBe(150)
  })
})

describe('tab strip edge hints', () => {
  it('marks each edge with the most urgent hidden tab, ignoring visible and finished ones', () => {
    const hidden = resolveTabStripHiddenTabs({ layouts, viewportWidth: 300, currentOffset: 300 })
    const tabStates = new Map([
      ['0', 'working'],
      ['1', 'done'],
      ['4', 'blocked'],
      ['8', 'working'],
      ['9', 'waiting']
    ] as const)
    expect(resolveTabStripEdgeHint(hidden.left, tabStates)).toBe('working')
    expect(resolveTabStripEdgeHint(hidden.right, tabStates)).toBe('waiting')
    expect(resolveTabStripEdgeHint(['1'], tabStates)).toBeNull()
  })
})
