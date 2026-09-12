import { describe, expect, it } from 'vitest'
import {
  clampBrowserZoomState,
  computeBrowserFrameGeometry,
  computeBrowserTouchClickRadiusCss,
  mapScreenToBrowserPoint,
  readLocalTouchPoint
} from './browser-touch-geometry'

describe('browser touch geometry', () => {
  it.each([390 / 980, 1, 1.25])(
    'maps page scale %s after client pan and zoom',
    (pageScaleFactor) => {
      const layout = { width: 390, height: 700 }
      const metadata = { deviceWidth: 390, deviceHeight: 664, pageScaleFactor, scrollOffsetY: 400 }
      const zoom = { scale: 2, offsetX: -30, offsetY: 20 }
      const point = { x: 120, y: 180 }
      const screenX = 195 + zoom.offsetX + (point.x * pageScaleFactor - 195) * zoom.scale
      const screenY = 350 + zoom.offsetY + (point.y * pageScaleFactor - 332) * zoom.scale
      expect(mapScreenToBrowserPoint(screenX, screenY, layout, metadata, zoom)).toEqual(point)
      expect(computeBrowserTouchClickRadiusCss(layout, metadata, zoom, 14)).toBe(
        Math.max(6, Math.min(48, Math.round(14 / (2 * pageScaleFactor))))
      )
    }
  )

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'uses legacy scale one for invalid/missing scale %s',
    (pageScaleFactor) => {
      expect(
        mapScreenToBrowserPoint(
          100,
          200,
          { width: 390, height: 700 },
          { deviceWidth: 390, deviceHeight: 700, pageScaleFactor },
          { scale: 1, offsetX: 0, offsetY: 0 }
        )
      ).toEqual({ x: 100, y: 200 })
    }
  )

  it('rejects letterbox touches before converting to CSS coordinates', () => {
    expect(
      mapScreenToBrowserPoint(
        195,
        5,
        { width: 390, height: 700 },
        { deviceWidth: 390, deviceHeight: 664, pageScaleFactor: 390 / 980 },
        { scale: 1, offsetX: 0, offsetY: 0 }
      )
    ).toBeNull()
  })
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
