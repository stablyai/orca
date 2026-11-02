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
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'

/** Below this an iOS browser zooms the page when an input takes focus, and does not zoom back. */
const IOS_FOCUS_ZOOM_FLOOR = 16

describe('the browser pane key row input on the web', () => {
  it('raises the key row input to the seam, above the focus-zoom floor', () => {
    expect(mobileBrowserPaneStyles.keyboardInput.fontSize).toBe(TEXT_INPUT_FONT_SIZE)
    expect(mobileBrowserPaneStyles.keyboardInput.fontSize).toBeGreaterThanOrEqual(
      IOS_FOCUS_ZOOM_FLOOR
    )
  })
})
