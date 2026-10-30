import { StyleSheet } from 'react-native'
import { getMobileColorScheme, type MobileColorScheme } from './mobile-theme'

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

// Drop-in for a module-scope `StyleSheet.create` that reads `colors`.
export function themedStyleSheet<T extends StyleSheet.NamedStyles<T>>(create: () => T): T {
  return themedStyles(() => StyleSheet.create(create()))
}
