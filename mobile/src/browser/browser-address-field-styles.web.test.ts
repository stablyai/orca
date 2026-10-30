import { describe, expect, it, vi } from 'vitest'

// Mock only identity StyleSheet.create; other RN exports require native runtime.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles }
}))

// Resolve web text-input seam as page does; native seam could falsely pass a size no browser renders.
vi.mock(
  '../platform/text-input-font-size',
  async () => await import('../platform/text-input-font-size.web')
)

import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { typography } from '../theme/mobile-theme'
import { browserAddressFieldStyles as browserAddressFieldStylesOnWeb } from './browser-address-field-styles.web'
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'

/** Below this an iOS browser zooms the page when an input takes focus, and does not zoom back. */
const IOS_FOCUS_ZOOM_FLOOR = 16

describe('the browser pane text inputs on the web', () => {
  it('raises the address field to the seam, above the focus-zoom floor', () => {
    expect(browserAddressFieldStylesOnWeb.input.fontSize).toBe(TEXT_INPUT_FONT_SIZE)
    expect(browserAddressFieldStylesOnWeb.input.fontSize).toBeGreaterThanOrEqual(
      IOS_FOCUS_ZOOM_FLOOR
    )
    // A raise rather than the same number twice: the native seam is the app's body size.
    expect(TEXT_INPUT_FONT_SIZE).toBeGreaterThan(typography.bodySize)
  })

  it('raises the key row input to the same seam', () => {
    expect(mobileBrowserPaneStyles.keyboardInput.fontSize).toBe(TEXT_INPUT_FONT_SIZE)
    expect(mobileBrowserPaneStyles.keyboardInput.fontSize).toBeGreaterThanOrEqual(
      IOS_FOCUS_ZOOM_FLOOR
    )
  })

  it('keeps the overlaid label on the input size, so focus does not resize the address', () => {
    expect(browserAddressFieldStylesOnWeb.fileLabel.fontSize).toBe(
      browserAddressFieldStylesOnWeb.input.fontSize
    )
    expect(browserAddressFieldStylesOnWeb.fileLabel.lineHeight).toBe(
      browserAddressFieldStylesOnWeb.input.lineHeight
    )
  })

  it('gives the raised size a line box it fits in', () => {
    expect(browserAddressFieldStylesOnWeb.input.lineHeight).toBeGreaterThanOrEqual(
      browserAddressFieldStylesOnWeb.input.fontSize
    )
  })
})
