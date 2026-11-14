import { describe, expect, it } from 'vitest'
import { measuredPageSafeAreaInsets, pageSafeAreaInsets } from './page-safe-area-insets'

describe('window-authoritative page insets', () => {
  const windowSafeArea = {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    insets: { top: 0, right: 84, bottom: 34, left: 0 }
  }
  const pageFrame = { x: 0, y: 0, width: 867, height: 669 }
  const nestedInsets = { top: 18, right: 0, bottom: 34, left: 0 }

  it.each([{ width: 951, height: 669, nestedTop: 18 }])(
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
})
