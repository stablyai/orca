import { describe, expect, it, vi } from 'vitest'

// StyleSheet.create is identity in React Native and on RN Web alike, and every other export of the
// module reaches the native runtime this test does not have.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles }
}))

// The seam as the page bundle resolves it. Without this the `.web.ts` style below would read the
// native seam and the test would pass on a size that no browser ever renders.
vi.mock(
  '../platform/text-input-font-size',
  async () => await import('../platform/text-input-font-size.web')
)

import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, typography } from '../theme/mobile-theme'
import { customKeyInputBase } from './custom-key-input-base-styles'
import { customKeyInputStyles } from './custom-key-input-styles'
import { customKeyInputStyles as customKeyInputStylesOnWeb } from './custom-key-input-styles.web'

/** Below this an iOS browser zooms the page when an input takes focus, and does not zoom back. */
const IOS_FOCUS_ZOOM_FLOOR = 16

/** Every property the capture field carried before it was split, read off the commit that split it. */
const BEFORE_THE_SPLIT = {
  width: '100%',
  height: 56,
  borderRadius: 10,
  backgroundColor: colors.bgPanel,
  borderWidth: 1,
  borderColor: colors.borderSubtle,
  color: colors.textPrimary,
  fontFamily: typography.monoFamily,
  fontSize: 22,
  fontWeight: '600',
  textAlign: 'center'
}

describe('the custom-key capture field natively', () => {
  it('renders exactly what it rendered before the split, property for property', () => {
    expect(customKeyInputStyles.keyInput).toEqual(BEFORE_THE_SPLIT)
    // Key for key as well as value for value: `toEqual` would pass over an extra undefined.
    expect(Object.keys(customKeyInputStyles.keyInput).sort()).toEqual(
      Object.keys(BEFORE_THE_SPLIT).sort()
    )
  })
})

describe('the custom-key capture field on the web', () => {
  it('takes its size from the seam, which clears the focus-zoom floor', () => {
    expect(customKeyInputStylesOnWeb.keyInput.fontSize).toBe(TEXT_INPUT_FONT_SIZE)
    expect(customKeyInputStylesOnWeb.keyInput.fontSize).toBeGreaterThanOrEqual(IOS_FOCUS_ZOOM_FLOOR)
  })

  /**
   * The one input on this screen the seam lowers rather than raises, recorded rather than implied.
   *
   * 22 already clears the floor, so this move buys nothing for the keyboard seam; what it buys is
   * that the census reads every size on the screen as a binding to one module. Written as a
   * comparison rather than as the number 16, so a theme that raised the body size past 22 would
   * make this fail and be read rather than silently reverse the direction.
   */
  it('is the one field the move shrinks, and says so', () => {
    expect(customKeyInputStylesOnWeb.keyInput.fontSize).toBeLessThan(BEFORE_THE_SPLIT.fontSize)
  })

  // The split is one value, not a second style: everything the siblings do not differ on comes from
  // the same object, so a padding or a colour cannot drift between the platforms.
  it('differs from the native style in nothing but the size', () => {
    expect(customKeyInputBase).not.toHaveProperty('fontSize')
    expect(customKeyInputStyles.keyInput).toMatchObject(customKeyInputBase)
    expect(customKeyInputStylesOnWeb.keyInput).toMatchObject(customKeyInputBase)
    expect(Object.keys(customKeyInputStylesOnWeb.keyInput).sort()).toEqual(
      Object.keys(customKeyInputStyles.keyInput).sort()
    )
  })
})
