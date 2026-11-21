import { codeFontFamily } from './mobile-code-font'
import { darkPalette, lightPalette } from './mobile-palette'
import type { MobilePalette } from './mobile-palette-roles'

export type { MobilePalette } from './mobile-palette-roles'

// Each platform resolves its own mobile-palette file: iOS system colours, Material 3 on Android, desktop on the web.
// Read colours from here instead of introducing inline ones.

export type MobileColorScheme = 'light' | 'dark'

// Orca's accent, the seed of the Android palette; Compose hosts take it to theme their controls to match.
export const materialSeedColor = '#3276f2'

const palettes: Record<MobileColorScheme, MobilePalette> = {
  dark: darkPalette,
  light: lightPalette
}

export function paletteForScheme(scheme: MobileColorScheme): MobilePalette {
  return palettes[scheme]
}

// Live object rewritten in place on a scheme change; read it at render time, never copy at module scope.
export const colors: MobilePalette = { ...darkPalette }

let currentScheme: MobileColorScheme = 'dark'
const schemeListeners = new Set<() => void>()

export function getMobileColorScheme(): MobileColorScheme {
  return currentScheme
}

export function applyMobileColorScheme(scheme: MobileColorScheme): void {
  if (scheme === currentScheme) {
    return
  }
  currentScheme = scheme
  Object.assign(colors, palettes[scheme])
  for (const listener of schemeListeners) {
    listener()
  }
}

export function subscribeMobileColorScheme(listener: () => void): () => void {
  schemeListeners.add(listener)
  return () => {
    schemeListeners.delete(listener)
  }
}

export const spacing = {
  /** Between quiet lines that read as one list (item lines in a chat). */
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
} as const

// Three shape types: one radius for what you tap, one for what holds content, and concentric nesting.
export const radii = {
  /** Everything you tap: buttons, icon buttons, text fields, pickers, segmented controls, key caps. */
  control: 12,
  /** Labels and round buttons: badges, chips, status pills, dots, avatars, and the composer's own buttons. */
  pill: 999,
  /** Everything that holds content: cards, groups, sheets, banners, code boxes, multi-line boxes, menus. */
  surface: 16,
  /** Layers floating over content: the composer box and dialogs. */
  floating: 24,
  /** Square icon tiles. */
  tile: 10,
  /** Inline code, check squares and tiny icons. */
  mark: 4
} as const

/** A shape inside another keeps its curve parallel to the parent's: the parent radius minus the gap between them. */
export function concentricRadius(parentRadius: number, inset: number): number {
  return Math.max(radii.mark, parentRadius - inset)
}

export const typography = {
  titleSize: 18,
  bodySize: 14,
  metaSize: 12,
  monoFamily: codeFontFamily
} as const

// One press and one disabled look for every control; fills on press use colors.translucentFill.
export const feedback = {
  pressedOpacity: 0.7,
  disabledOpacity: 0.4
} as const

/** The pressed look for a button: `style={({ pressed }) => [styles.button, pressed && pressedStyle]}`. */
export const pressedStyle = { opacity: feedback.pressedOpacity } as const
