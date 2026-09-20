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

/**
 * What Chromium paints for `dialog.html`, the C6.6 fixture with no `<meta name="viewport">`.
 *
 * Measured on Chromium 1217, 2026-09-20, under a 402x593 mobile emulation at device scale 1.91:
 * the page lays out at 980 CSS px and the frame metadata comes back with `deviceWidth` 402 and
 * `pageScaleFactor` 402/980. `Input.dispatchMouseEvent` takes page CSS coordinates, unscaled, and
 * `scrollOffsetX/Y` must not be added to them — a click sent at `device / scale + scrollOffset`
 * landed 300 px below its target on a scrolled page, and `device / scale` hit it.
 */
const NO_VIEWPORT_META = {
  deviceWidth: 402,
  deviceHeight: 593,
  pageScaleFactor: 0.41020408272743225,
  scrollOffsetX: 0,
  scrollOffsetY: 300
}

/** The fixture's alert button, in the page's own CSS pixels. */
const BUTTON = { left: 32, top: 112, right: 115, bottom: 162 }

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

  it('inverts pan and zoom around the rendered frame center', () => {
    const layout = { width: 390, height: 700 }
    const metadata = { deviceWidth: 1280, deviceHeight: 720 }
    const geometry = computeBrowserFrameGeometry(layout, metadata)!
    const zoom = { scale: 2, offsetX: -48, offsetY: 32 }
    const browserPoint = { x: 960, y: 540 }
    const localX = (browserPoint.x / metadata.deviceWidth) * geometry.renderedWidth
    const localY = (browserPoint.y / metadata.deviceHeight) * geometry.renderedHeight
    const screenX =
      geometry.offsetX +
      geometry.renderedWidth / 2 +
      zoom.offsetX +
      (localX - geometry.renderedWidth / 2) * zoom.scale
    const screenY =
      geometry.offsetY +
      geometry.renderedHeight / 2 +
      zoom.offsetY +
      (localY - geometry.renderedHeight / 2) * zoom.scale

    expect(mapScreenToBrowserPoint(screenX, screenY, layout, metadata, zoom)).toEqual(browserPoint)
  })

  it('maps a tap on a page with no viewport meta into the page CSS pixels', () => {
    const layout = { width: 402, height: 593 }
    const scale = NO_VIEWPORT_META.pageScaleFactor
    // Where the button's centre is painted in the frame, which is where the finger goes.
    const paintedX = ((BUTTON.left + BUTTON.right) / 2) * scale
    const paintedY = ((BUTTON.top + BUTTON.bottom) / 2) * scale

    const point = mapScreenToBrowserPoint(paintedX, paintedY, layout, NO_VIEWPORT_META, NO_ZOOM)!

    expect(point.x).toBeGreaterThanOrEqual(BUTTON.left)
    expect(point.x).toBeLessThanOrEqual(BUTTON.right)
    expect(point.y).toBeGreaterThanOrEqual(BUTTON.top)
    expect(point.y).toBeLessThanOrEqual(BUTTON.bottom)
    // What the device proof recorded instead: the frame's own device space, 41% of the aim, on BODY.
    expect(point).not.toEqual({ x: 30, y: 56 })
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

  it('leaves web view mode where it was, at a page scale of one', () => {
    const layout = { width: 402, height: 593 }
    const metadata = { deviceWidth: 402, deviceHeight: 593, pageScaleFactor: 1 }

    expect(mapScreenToBrowserPoint(120, 240, layout, metadata, NO_ZOOM)).toEqual({ x: 120, y: 240 })
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

    // A 100 point flick up. The frame fits the pane one to one, so the only factor left is the
    // page scale: 100 screen points span 100 / 0.41 CSS pixels of a page laid out at 980.
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
