import { Easing, useReducedMotion } from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from './sheet-motion-values'

export const BOTTOM_DRAWER_EASING = Easing.bezier(...SHEET_CURVE)
export const BOTTOM_DRAWER_SHOW_DURATION_MS = 480
export const BOTTOM_DRAWER_HIDE_DURATION_MS = 300
export const BOTTOM_DRAWER_HEIGHT_DURATION_MS = SHEET_HEIGHT_DURATION_MS

/**
 * Reduce Motion as soon as it is known: the live accessibility value once read, Reanimated's
 * launch-time value before that, so a drawer opened on mount never slides under Reduce Motion.
 */
export function useDrawerReducedMotion(): boolean {
  const launchValue = useReducedMotion()
  return useReducedMotionEnabled() ?? launchValue
}
