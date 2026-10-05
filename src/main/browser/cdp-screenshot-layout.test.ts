import { describe, expect, it } from 'vitest'

import { getLayoutClip, type CdpLayoutMetrics } from './cdp-screenshot-layout'

describe('getLayoutClip', () => {
  it('converts CSS content dimensions to DIP at page zoom above one', () => {
    expect(
      getLayoutClip({
        cssContentSize: { width: 909, height: 2749 },
        cssVisualViewport: { zoom: 1.25 }
      })
    ).toEqual({ x: 0, y: 0, width: 1137, height: 3437, scale: 1 })
  })

  it('converts CSS content dimensions to DIP at page zoom below one', () => {
    expect(
      getLayoutClip({
        cssContentSize: { width: 1000.1, height: 2000.1 },
        cssVisualViewport: { zoom: 0.8 }
      })
    ).toEqual({ x: 0, y: 0, width: 801, height: 1601, scale: 1 })
  })

  it('does not apply device scale factor to a CSS layout clip', () => {
    const metrics: CdpLayoutMetrics & { deviceScaleFactor: number } = {
      cssContentSize: { width: 980, height: 2749 },
      cssVisualViewport: { zoom: 1 },
      deviceScaleFactor: 3
    }
    expect(getLayoutClip(metrics)).toEqual({ x: 0, y: 0, width: 980, height: 2749, scale: 1 })
  })

  it('uses unscaled CSS dimensions when older metrics omit page zoom', () => {
    expect(getLayoutClip({ cssContentSize: { width: 640.25, height: 1280.75 } })).toEqual({
      x: 0,
      y: 0,
      width: 641,
      height: 1281,
      scale: 1
    })
  })

  it('falls back to legacy DIP content dimensions when CSS dimensions are unavailable', () => {
    expect(
      getLayoutClip({
        contentSize: { width: 800.2, height: 1600.2 },
        cssVisualViewport: { zoom: 1.25 }
      })
    ).toEqual({ x: 0, y: 0, width: 801, height: 1601, scale: 1 })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid CSS page zoom %p',
    (zoom) => {
      expect(
        getLayoutClip({
          cssContentSize: { width: 640, height: 1280 },
          cssVisualViewport: { zoom }
        })
      ).toBeNull()
    }
  )
})
