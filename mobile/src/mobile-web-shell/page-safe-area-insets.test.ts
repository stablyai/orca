import { describe, expect, it, vi } from 'vitest'
import { measuredPageSafeAreaInsets, pageSafeAreaInsets } from './page-safe-area-insets'

const WINDOW = { top: 52, right: 12, bottom: 24, left: 12 }

describe('the insets the page pads for', () => {
  it('is the window insets while nothing of the shell stands over the view', () => {
    expect(pageSafeAreaInsets({ insets: WINDOW, topCovered: false })).toEqual(WINDOW)
  })

  it('has no top while the shell banner takes the status bar strip', () => {
    expect(pageSafeAreaInsets({ insets: WINDOW, topCovered: true })).toEqual({ ...WINDOW, top: 0 })
  })
})

describe('window-authoritative page insets', () => {
  const windowSafeArea = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    insets: { top: 0, right: 84, bottom: 34, left: 0 }
  }
  const pageFrame = { x: 0, y: 0, width: 867, height: 669 }
  const nestedInsets = { top: 18, right: 0, bottom: 34, left: 0 }

  it.each([
    { width: 466, height: 678, nestedTop: 52 / 3 },
    { width: 951, height: 669, nestedTop: 18 }
  ])(
    'removes the nested top gap for a $width pt window while keeping bottom protection',
    ({ width, height, nestedTop }) => {
      expect(
        measuredPageSafeAreaInsets(
          { ...windowSafeArea, bounds: { x: 0, y: 0, width, height } },
          { x: 0, y: 0, width: width - 84, height },
          { ...nestedInsets, top: nestedTop }
        )
      ).toEqual({
        top: 0,
        right: 0,
        bottom: 34,
        left: 0
      })
    }
  )

  it('subtracts sidebar and banner offsets already consumed outside the WebView', () => {
    expect(
      measuredPageSafeAreaInsets(
        {
          bounds: { x: 100, y: 200, width: 951, height: 669 },
          insets: { top: 84, right: 84, bottom: 34, left: 20 }
        },
        { x: 110, y: 240, width: 857, height: 629 },
        nestedInsets
      )
    ).toEqual({
      top: 44,
      right: 0,
      bottom: 34,
      left: 10
    })
    expect(
      measuredPageSafeAreaInsets(
        windowSafeArea,
        {
          x: 200,
          y: 20,
          width: 667,
          height: 600
        },
        nestedInsets
      )
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  it('preserves real top exclusions and the banner override without changing bottom protection', () => {
    const insets = measuredPageSafeAreaInsets(
      {
        ...windowSafeArea,
        insets: { top: 84, right: 0, bottom: 34, left: 0 }
      },
      pageFrame,
      nestedInsets
    )
    expect(insets.top).toBe(84)
    expect(pageSafeAreaInsets({ insets, topCovered: true })).toEqual({
      top: 0,
      right: 0,
      bottom: 34,
      left: 0
    })
  })

  it('uses the existing behavior until geometry arrives, including old native modules', () => {
    expect(measuredPageSafeAreaInsets(undefined, pageFrame, nestedInsets)).toBe(nestedInsets)
    expect(measuredPageSafeAreaInsets(windowSafeArea, null, nestedInsets)).toBe(nestedInsets)
  })

  it('bounds untrusted geometry and logs a malformed producer before falling back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (const bounds of [
        { ...windowSafeArea.bounds, width: 0 },
        { ...windowSafeArea.bounds, width: 5000 },
        { ...windowSafeArea.bounds, x: Number.NaN }
      ]) {
        expect(
          measuredPageSafeAreaInsets({ ...windowSafeArea, bounds }, pageFrame, nestedInsets)
        ).toBe(nestedInsets)
      }
      expect(
        measuredPageSafeAreaInsets(
          {
            ...windowSafeArea,
            insets: { ...windowSafeArea.insets, bottom: 700 }
          },
          pageFrame,
          nestedInsets
        )
      ).toBe(nestedInsets)
      expect(
        measuredPageSafeAreaInsets(
          windowSafeArea,
          { ...pageFrame, height: Number.POSITIVE_INFINITY },
          nestedInsets
        )
      ).toBe(nestedInsets)
      expect(warn).toHaveBeenCalledTimes(5)
    } finally {
      warn.mockRestore()
    }
  })
})
