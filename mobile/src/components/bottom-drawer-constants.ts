import { Easing } from 'react-native-reanimated'
import { SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from './sheet-motion-values'

export const BOTTOM_DRAWER_EASING = Easing.bezier(...SHEET_CURVE)
export const BOTTOM_DRAWER_SHOW_DURATION_MS = 480
export const BOTTOM_DRAWER_HIDE_DURATION_MS = 300
export const BOTTOM_DRAWER_HEIGHT_DURATION_MS = SHEET_HEIGHT_DURATION_MS
