import { useSyncExternalStore } from 'react'
import {
  getMobileColorScheme,
  paletteForScheme,
  subscribeMobileColorScheme,
  type MobileColorScheme,
  type MobilePalette
} from './mobile-theme'

export function useMobileColorScheme(): MobileColorScheme {
  return useSyncExternalStore(subscribeMobileColorScheme, getMobileColorScheme)
}

// One frozen palette per scheme, so a scheme change is a new value React Compiler can track.
export function useMobileColors(): MobilePalette {
  return paletteForScheme(useMobileColorScheme())
}
