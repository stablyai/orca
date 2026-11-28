import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'
import { paletteForScheme, radii, type MobileColorScheme, type MobilePalette } from './mobile-theme'
import { useMobileColorScheme } from './use-mobile-color-scheme'

// RN 0.88's generated types dropped StyleSheet.NamedStyles; this mapped constraint keeps literal inference.
type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle }

// A per-scheme style factory. Render code resolves it with useThemedStyles() so React Compiler
// tracks the scheme; anything holding a scheme already can call resolve().
export type ThemedStyles<T> = { readonly resolve: (scheme: MobileColorScheme) => T }

export function themedStyles<T>(
  create: (colors: MobilePalette, scheme: MobileColorScheme) => T
): ThemedStyles<T> {
  const built = new Map<MobileColorScheme, T>()
  return {
    resolve: (scheme) => {
      let styles = built.get(scheme)
      if (styles === undefined) {
        styles = create(paletteForScheme(scheme), scheme)
        built.set(scheme, styles)
      }
      return styles
    }
  }
}

export function useThemedStyles<T>(sheet: ThemedStyles<T>): T {
  return sheet.resolve(useMobileColorScheme())
}

const CORNER_RADIUS_KEYS = [
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius'
] as const

const BORDER_WIDTH_KEYS = [
  'borderWidth',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth'
] as const

type CornerStyle = {
  borderRadius?: unknown
  width?: unknown
  height?: unknown
  overflow?: unknown
} & Partial<Record<(typeof BORDER_WIDTH_KEYS)[number], unknown>>

// Styles that must keep the circular curve: a continuous curve squares off circles and pills, and
// React Native strokes an unclipped visible border on a circular path while filling the background
// with the continuous one, so their edges would not line up.
function keepsCircularCurve(style: CornerStyle): boolean {
  const { borderRadius, width, height } = style
  if (typeof borderRadius === 'number') {
    if (borderRadius >= radii.pill) {
      return true
    }
    if (
      typeof width === 'number' &&
      typeof height === 'number' &&
      borderRadius * 2 >= Math.min(width, height)
    ) {
      return true
    }
  }
  const hasVisibleBorder = BORDER_WIDTH_KEYS.some((key) => {
    const value = style[key]
    return typeof value === 'number' && value > 0
  })
  return hasVisibleBorder && style.overflow !== 'hidden'
}

// Every rounded style asks for Apple's continuous corner curve; iOS draws it, Android and the web ignore the key.
// Mutates the fresh objects `create()` just built.
function withContinuousCorners<T extends NamedStyles<T>>(styles: T): T {
  for (const style of Object.values<ViewStyle | TextStyle | ImageStyle>(styles)) {
    if (
      style &&
      typeof style === 'object' &&
      !('borderCurve' in style) &&
      CORNER_RADIUS_KEYS.some((key) => key in style) &&
      !keepsCircularCurve(style)
    ) {
      Object.assign(style, { borderCurve: 'continuous' })
    }
  }
  return styles
}

// Module-scope `StyleSheet.create` whose values read the scheme's colors.
export function themedStyleSheet<T extends NamedStyles<T>>(
  create: (colors: MobilePalette, scheme: MobileColorScheme) => T
): ThemedStyles<T> {
  return themedStyles((colors, scheme) =>
    StyleSheet.create(withContinuousCorners(create(colors, scheme)))
  )
}
