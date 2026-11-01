import { afterEach, expect, it, vi } from 'vitest'
import { applyMobileColorScheme, colors, paletteForScheme } from './mobile-theme'
import { themedStyles } from './themed-styles'

vi.mock('react-native', () => ({ StyleSheet: { create: <T>(styles: T): T => styles } }))

afterEach(() => {
  applyMobileColorScheme('dark')
})

it('serves each scheme its own stylesheet, including ones built before the switch', () => {
  const styles = themedStyles(() => ({ row: { backgroundColor: colors.bgBase } }))
  const merged = themedStyles(() => ({ ...styles }))
  expect(merged.row.backgroundColor).toBe(paletteForScheme('dark').bgBase)

  applyMobileColorScheme('light')
  expect(styles.row.backgroundColor).toBe(paletteForScheme('light').bgBase)
  expect(merged.row.backgroundColor).toBe(paletteForScheme('light').bgBase)

  applyMobileColorScheme('dark')
  expect(merged.row.backgroundColor).toBe(paletteForScheme('dark').bgBase)
})
