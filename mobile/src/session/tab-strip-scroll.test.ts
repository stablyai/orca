import { describe, expect, it } from 'vitest'
import { resolveTabStripScrollOffset } from './tab-strip-scroll'

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
