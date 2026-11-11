import { describe, expect, it } from 'vitest'
import {
  browserWheelDeltaFromScreen,
  clampBrowserZoomState,
  computeBrowserFrameGeometry,
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint,
  readLocalTouchPoint
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
  it('maps the visual center of a letterboxed desktop frame to the browser center', () => {
    const layout = { width: 390, height: 700 }
    const metadata = { deviceWidth: 1280, deviceHeight: 720 }
    const geometry = computeBrowserFrameGeometry(layout, metadata)

    expect(geometry).toMatchObject({
      renderedWidth: 390,
      offsetX: 0,
      sourceWidth: 1280,
      sourceHeight: 720
    })
    expect(
      mapScreenToBrowserPoint(
        195,
        geometry!.offsetY + geometry!.renderedHeight / 2,
        layout,
        metadata,
        { scale: 1, offsetX: 0, offsetY: 0 }
      )
    ).toEqual({ x: 640, y: 360 })
  })

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

  it('reads a missing or unusable page scale as one rather than dividing by it', () => {
    const layout = { width: 402, height: 593 }
    for (const pageScaleFactor of [undefined, 0, -1, Number.NaN]) {
      expect(
        mapScreenToBrowserPoint(
          120,
          240,
          layout,
          { deviceWidth: 402, deviceHeight: 593, pageScaleFactor },
          NO_ZOOM
        )
      ).toEqual({ x: 120, y: 240 })
    }
  })

  it('grows the touch radius by the page scale, because a CSS pixel is smaller', () => {
    const layout = { width: 400, height: 600 }
    const metadata = { deviceWidth: 400, deviceHeight: 600, pageScaleFactor: 0.5 }

    expect(computeBrowserTouchClickRadiusCss(layout, metadata, NO_ZOOM, 14)).toBe(28)
    expect(
      computeBrowserTouchClickRadiusCss(layout, { ...metadata, pageScaleFactor: 1 }, NO_ZOOM, 14)
    ).toBe(14)
  })

  it('scrolls the page by the page scale, not by the frame fit alone', () => {
    const layout = { width: 402, height: 593 }
    const geometry = computeBrowserFrameGeometry(layout, NO_VIEWPORT_META)

    // 100-screen-point flick spans 100/0.41 CSS pixels on default 980px page; frame fits pane 1:1.
    const delta = browserWheelDeltaFromScreen(0, 100, geometry, 1)

    expect(delta.dy).toBe(-244)
    expect(delta.dx).toBe(0)
    // What it sent before: the screen delta itself, 41% of the scroll asked for.
    expect(delta.dy).not.toBe(-100)
  })

  it('leaves a web view scroll and a pinched one where they were', () => {
    const layout = { width: 402, height: 593 }
    const unscaled = computeBrowserFrameGeometry(layout, {
      deviceWidth: 402,
      deviceHeight: 593,
      pageScaleFactor: 1
    })

    expect(browserWheelDeltaFromScreen(0, 100, unscaled, 1)).toEqual({ dx: 0, dy: -100 })
    // A pinch to 2x halves what a screen point is worth, on top of whatever the page scale is.
    expect(browserWheelDeltaFromScreen(0, 100, unscaled, 2)).toEqual({ dx: 0, dy: -50 })
    expect(browserWheelDeltaFromScreen(-40, 0, null, 1)).toEqual({ dx: 40, dy: 0 })
  })

  it('rejects page-level touch coordinates instead of mixing coordinate spaces', () => {
    expect(readLocalTouchPoint({ pageX: 120, pageY: 240 })).toBeNull()
  })

  it('clamps zoom offsets after the viewport geometry changes', () => {
    const nextGeometry = computeBrowserFrameGeometry(
      { width: 390, height: 700 },
      { deviceWidth: 1280, deviceHeight: 720 }
    )!

    const clamped = clampBrowserZoomState(
      { scale: 3.5, offsetX: 300, offsetY: 500 },
      nextGeometry,
      1,
      3.5
    )

    expect(clamped.scale).toBe(3.5)
    expect(clamped.offsetX).toBe(300)
    expect(clamped.offsetY).toBeCloseTo(33.90625)
  })
})
