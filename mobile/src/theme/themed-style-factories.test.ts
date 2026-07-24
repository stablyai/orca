import { describe, expect, it, vi } from 'vitest'
import type { ThemeColors } from './mobile-theme'
import { darkColors, lightColors } from './mobile-theme'

// Why identity: factories only need key-set + deep-inequality checks; RN is unavailable in vitest.
vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T extends Record<string, unknown>>(sheet: T): T => sheet
  }
}))

// Appended by every themed-styles batch. Empty until the first conversion lands.
type StyleFactory = {
  readonly name: string
  readonly factory: (colors: ThemeColors) => Record<string, unknown>
}

const THEMED_STYLE_FACTORIES: readonly StyleFactory[] = []

describe('themed style factories', () => {
  it('emits the same keys in both palettes and differs in value', () => {
    for (const { name, factory } of THEMED_STYLE_FACTORIES) {
      const darkSheet = factory(darkColors)
      const lightSheet = factory(lightColors)
      expect(Object.keys(darkSheet).sort(), name).toEqual(Object.keys(lightSheet).sort())
      expect(darkSheet, name).not.toEqual(lightSheet)
    }
  })
})
