import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { applyMobileColorScheme, darkColors, lightColors } from '../theme/mobile-theme'

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (value: unknown) => value }
}))
import { MobileNativeChatVisualFrame } from './MobileNativeChatVisualFrame'

it('updates a sealed visualization document across light and dark palettes', () => {
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(
      createElement(MobileNativeChatVisualFrame, {
        html: '<p>Chart</p>',
        title: 'Chart',
        mode: 'inline',
        onFailed() {}
      })
    )
  })
  try {
    for (const scheme of ['light', 'dark', 'light'] as const) {
      act(() => applyMobileColorScheme(scheme))
      const palette = scheme === 'light' ? lightColors : darkColors
      const frame = tree.root.findByType('iframe')
      expect(frame.props.srcDoc).toContain(palette.bgBase)
      expect(frame.props.srcDoc).toContain('<p>Chart</p>')
      expect(frame.props.sandbox).toBe('')
    }
  } finally {
    act(() => tree.unmount())
    applyMobileColorScheme('dark')
  }
})
