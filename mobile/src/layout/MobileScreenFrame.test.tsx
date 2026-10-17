import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { applyMobileColorScheme, darkColors, lightColors } from '../theme/mobile-theme'
import { MobileScreenFrame } from './MobileScreenFrame'
vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  applyMobileColorScheme('dark')
})
it.each(['panel', 'base'] as const)(
  'keeps %s headers and their status inset on the same surface',
  (headerSurface) => {
    act(() => {
      tree = create(
        <MobileScreenFrame headerSurface={headerSurface} header={createElement('Header')}>
          {createElement('Body')}
        </MobileScreenFrame>
      )
    })
    for (const scheme of ['light', 'dark', 'light'] as const) {
      act(() => applyMobileColorScheme(scheme))
      const palette = scheme === 'light' ? lightColors : darkColors
      const inset = tree!.root.find((node) => String(node.type) === 'SafeAreaView')
      expect(inset.props.style.backgroundColor).toBe(
        headerSurface === 'panel' ? palette.bgPanel : palette.bgBase
      )
      expect(inset.props.edges).toEqual(['top'])
      expect(inset.findAll((node) => String(node.type) === 'Body')).toHaveLength(0)
      const canvas = tree!.root.findAll((node) => String(node.type) === 'View')
      expect(canvas.every((node) => node.props.style.backgroundColor === palette.bgBase)).toBe(true)
    }
  }
)
it('updates a retained page when its next header uses a different surface', () => {
  applyMobileColorScheme('light')
  act(() => {
    tree = create(<MobileScreenFrame header={createElement('Header')}>{null}</MobileScreenFrame>)
  })
  act(() =>
    tree!.update(
      <MobileScreenFrame headerSurface="base" header={createElement('NextHeader')}>
        {null}
      </MobileScreenFrame>
    )
  )
  const inset = tree!.root.find((node) => String(node.type) === 'SafeAreaView')
  expect(inset.props.style.backgroundColor).toBe(lightColors.bgBase)
})
