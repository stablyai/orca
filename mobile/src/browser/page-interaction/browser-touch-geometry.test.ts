import { describe, expect, it } from 'vitest'
import {
  browserWheelDeltaFromScreen,
  computeBrowserFrameGeometry,
  mapScreenToBrowserPoint
} from './browser-touch-geometry'

const NO_ZOOM = { scale: 1, offsetX: 0, offsetY: 0 }

// Measured Chromium 1217 (2026-09-20): no-viewport-meta page lays out at 980 CSS px within 402×593 emulation, scale 402/980.
// CDP takes viewport-relative CSS coordinates: divide device by scale without scroll offsets, which overshot a scrolled target by 300px.
const NO_VIEWPORT_META = {
  deviceWidth: 402,
  deviceHeight: 593,
  pageScaleFactor: 0.41020408272743225,
  scrollOffsetX: 0,
  scrollOffsetY: 300
}

describe('browser touch geometry', () => {
  it('divides the frame device space by the page scale and adds no scroll offset', () => {
    const layout = { width: 400, height: 600 }
    const metadata = {
      deviceWidth: 400,
      deviceHeight: 600,
      pageScaleFactor: 0.5,
      scrollOffsetX: 70,
      scrollOffsetY: 300
    }

    expect(mapScreenToBrowserPoint(100, 200, layout, metadata, NO_ZOOM)).toEqual({ x: 200, y: 400 })
  })

  it('scrolls the page by the page scale, not by the frame fit alone', () => {
    const layout = { width: 402, height: 593 }
    const geometry = computeBrowserFrameGeometry(layout, NO_VIEWPORT_META)

    // 100-screen-point flick spans 100/0.41 CSS pixels on default 980px page; frame fits pane 1:1.
    const delta = browserWheelDeltaFromScreen(0, 100, geometry, 1)

    expect(delta.dy).toBe(-244)
    expect(delta.dx).toBe(0)
  })
})
