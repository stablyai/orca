import { describe, expect, it } from 'vitest'
import { getHorizontalEdgePadding, getScreenEdgePadding } from './screen-edge-padding-metrics'
import { spacing } from '../theme/mobile-theme'

// Insets modelled on an iPhone with a Dynamic Island: the housing reports a top
// inset in portrait and side insets once the device is rotated.
const PORTRAIT = { top: 59, left: 0, right: 0 }
const LANDSCAPE = { top: 0, left: 59, right: 59 }

describe('screen edge padding metrics', () => {
  it('insets both sides in landscape so the housing cannot cover content', () => {
    expect(getScreenEdgePadding(LANDSCAPE)).toEqual({
      paddingTop: spacing.sm,
      paddingLeft: 59,
      paddingRight: 59
    })
  })

  it('pads only the side the housing is on', () => {
    expect(getHorizontalEdgePadding({ top: 0, left: 59, right: 0 })).toEqual({ paddingLeft: 59 })
  })

  // Yoga resolves an edge ahead of the shorthand, so emitting `paddingLeft: 0` would
  // override a container's own `padding`/`paddingHorizontal` and silently strip its
  // gutter in portrait. Asserting on the keys is the point: a 0 value would pass a
  // value-only check while still regressing every screen that sets the shorthand.
  it('omits a side entirely when its inset is zero, leaving container padding intact', () => {
    expect(getHorizontalEdgePadding(PORTRAIT)).toEqual({})
    expect(Object.keys(getScreenEdgePadding(PORTRAIT))).toEqual(['paddingTop'])
  })
})
