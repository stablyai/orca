import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { applyMobileColorScheme, darkColors, lightColors } from '../theme/mobile-theme'
import { MobileSegmentedControl } from './MobileSegmentedControl'
import { MobileSwitch } from './MobileSwitch'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  Switch: 'Switch',
  StyleSheet: { create: (styles: unknown) => styles }
}))
let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  applyMobileColorScheme('dark')
})
it('repaints mounted workspace segments when the palette changes', () => {
  act(() => {
    tree = create(
      createElement(MobileSegmentedControl, {
        segments: [{ value: 'all', label: 'All' }],
        selected: 'all',
        onSelect: () => {}
      })
    )
  })
  for (const scheme of ['light', 'dark', 'light'] as const) {
    act(() => applyMobileColorScheme(scheme))
    const palette = scheme === 'light' ? lightColors : darkColors
    const track = tree!.root.find((node) => String(node.type) === 'View')
    expect(track.props.style[0].backgroundColor).toBe(palette.bgBase)
    const label = tree!.root.find((node) => String(node.type) === 'Text')
    expect(label.props.style[1].color).toBe(palette.textPrimary)
  }
})
it('refreshes both web and native switch thumbs without remounting', () => {
  act(() => {
    tree = create(
      createElement(MobileSwitch, {
        value: true,
        onValueChange: () => {},
        accessibilityLabel: 'Show workspaces'
      })
    )
  })
  for (const scheme of ['light', 'dark', 'light'] as const) {
    act(() => applyMobileColorScheme(scheme))
    const palette = scheme === 'light' ? lightColors : darkColors
    const control = tree!.root.find((node) => String(node.type) === 'Switch')
    expect(control.props.activeThumbColor).toBe(palette.textPrimary)
    expect(control.props.thumbColor).toBe(palette.textPrimary)
    expect(control.props.trackColor.true).toBe(palette.textSecondary)
  }
})
