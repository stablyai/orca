import { afterEach, expect, it } from 'vitest'
import { applyMobileColorScheme, colors, darkColors, lightColors } from './mobile-theme'
import { createThemedStyles } from './mobile-themed-styles'

afterEach(() => applyMobileColorScheme('dark'))
it('switches existing style references and reuses the same native styles when returning', () => {
  const styles = createThemedStyles(() => ({ row: { color: colors.textPrimary } }))
  const original = styles.row
  expect(original.color).toBe(darkColors.textPrimary)
  applyMobileColorScheme('light')
  expect(styles.row.color).toBe(lightColors.textPrimary)
  expect(styles.row).not.toBe(original)
  expect({ ...styles }.row).toBe(styles.row)
  applyMobileColorScheme('dark')
  expect(styles.row).toBe(original)
})
