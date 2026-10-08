import { describe, expect, it } from 'vitest'
import type { DesktopBrowserViewLayout } from '../../shared/desktop-browser-view-protocol'
import { getDesktopBrowserViewLayout } from './desktop-browser-view-layout'

const layout: DesktopBrowserViewLayout = {
  browserPageId: 'page',
  generation: 'generation',
  bounds: { x: 30, y: 50, width: 390, height: 844 },
  clipBounds: { x: 10, y: 50, width: 600, height: 500 },
  visible: true,
  inputLocked: false
}
const owner = { width: 900, height: 650 }

describe('native browser viewport clipping', () => {
  it('keeps the full device preset inside a smaller clipped pane', () => {
    expect(getDesktopBrowserViewLayout(layout, owner, 1)).toEqual({
      container: { x: 30, y: 50, width: 390, height: 500 },
      content: { x: 0, y: 0, width: 390, height: 844 },
      visible: true
    })
  })

  it('preserves negative offsets when the renderer scrolls a large preset', () => {
    const scrolled = { ...layout, bounds: { x: -20, y: -70, width: 1000, height: 900 } }
    expect(getDesktopBrowserViewLayout(scrolled, owner, 1)).toEqual({
      container: { x: 10, y: 50, width: 600, height: 500 },
      content: { x: -30, y: -120, width: 1000, height: 900 },
      visible: true
    })
  })

  it('converts renderer zoom once and clips to the actual owner dimensions', () => {
    expect(getDesktopBrowserViewLayout(layout, owner, 2)).toEqual({
      container: { x: 60, y: 100, width: 780, height: 550 },
      content: { x: 0, y: 0, width: 780, height: 1688 },
      visible: true
    })
  })

  it('hides wholly outside, locked and inactive pages without changing their size', () => {
    for (const hidden of [
      { ...layout, bounds: { ...layout.bounds, x: 1000 } },
      { ...layout, inputLocked: true },
      { ...layout, visible: false }
    ]) {
      const result = getDesktopBrowserViewLayout(hidden, owner, 1)
      expect(result.visible).toBe(false)
      expect(result.content).toMatchObject({ width: 390, height: 844 })
    }
  })
})
