import { useSyncExternalStore } from 'react'
import {
  getMobileColorScheme,
  subscribeMobileColorScheme,
  type MobileColorScheme
} from './mobile-theme'

// Call in every component that reads `colors` or themed styles while rendering, so a scheme change repaints it.
export function useMobileColorScheme(): MobileColorScheme {
  return useSyncExternalStore(subscribeMobileColorScheme, getMobileColorScheme)
}
