import { describe, expect, it } from 'vitest'
import { resolveTabStripScrollOffset, resolveTabStripTapOffset } from './tab-strip-scroll'

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
        currentOffset: 0
      })
    ).toBe(0)
  })
})

describe('tab taps reveal the next neighbor on that edge', () => {
  const tabs = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
  const layouts = new Map(tabs.map((tab, i) => [tab.id, { x: i * 108, width: 100 }]))
  const tap = (tabId: string, currentOffset: number, viewportWidth = 300) =>
    resolveTabStripTapOffset({
      tabId,
      tabs,
      layouts,
      viewportWidth,
      contentWidth: 1080,
      currentOffset
    })

  it('reveals the left neighbor when tapping near the left edge', () => {
    const offset = tap('3', 300)
    expect(offset).toBeLessThan(300)
    expect(offset).toBeLessThanOrEqual(layouts.get('2')!.x)
    expect(offset + 300).toBeGreaterThanOrEqual(424)
  })
  it('reveals the right neighbor when tapping near the right edge', () => {
    const offset = tap('4', 240)
    expect(offset).toBeGreaterThan(240)
    expect(offset + 300).toBeGreaterThanOrEqual(640)
    expect(offset).toBeLessThanOrEqual(432)
  })
  it('does not move when the selected tab and next neighbor are already visible', () => {
    expect(tap('3', 100, 500)).toBe(100)
  })
  it('clamps the first and last tab to the content edges', () => {
    expect(tap('0', 0)).toBe(0)
    expect(tap('9', 780)).toBe(780)
  })
  it('keeps a wide selected tab visible and exposes a tappable part of its next neighbor', () => {
    const wide = new Map([
      ['a', { x: 0, width: 180 }],
      ['b', { x: 188, width: 180 }],
      ['c', { x: 376, width: 180 }]
    ])
    const offset = resolveTabStripTapOffset({
      tabId: 'b',
      tabs: ['a', 'b', 'c'].map((id) => ({ id })),
      layouts: wide,
      viewportWidth: 256,
      contentWidth: 556,
      currentOffset: 150
    })
    expect(offset).toBeLessThanOrEqual(188)
    expect(offset + 256).toBeGreaterThanOrEqual(420)
  })
  it('waits for layout instead of jumping for a missing tab or zero viewport', () => {
    expect(tap('missing', 150)).toBe(150)
    expect(tap('3', 150, 0)).toBe(150)
  })
})
