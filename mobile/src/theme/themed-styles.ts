import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native'
import { getMobileColorScheme, radii, type MobileColorScheme } from './mobile-theme'

// Module-scope styles that read `colors`: built once per scheme, and every key reads the current scheme's copy.
export function themedStyles<T extends Record<string, unknown>>(create: () => T): T {
  const built = new Map<MobileColorScheme, T>()
  const current = (): T => {
    const scheme = getMobileColorScheme()
    let styles = built.get(scheme)
    if (styles === undefined) {
      styles = create()
      built.set(scheme, styles)
    }
    return styles
  }
  const live = { ...current() }
  for (const key of Object.keys(live)) {
    Object.defineProperty(live, key, { enumerable: true, get: () => current()[key] })
  }
  return live
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
function withContinuousCorners<T extends StyleSheet.NamedStyles<T>>(styles: T): T {
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

// Drop-in for a module-scope `StyleSheet.create` that reads `colors`.
export function themedStyleSheet<T extends StyleSheet.NamedStyles<T>>(create: () => T): T {
  return themedStyles(() => StyleSheet.create(withContinuousCorners(create())))
}
