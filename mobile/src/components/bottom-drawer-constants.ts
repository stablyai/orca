import { Easing } from 'react-native-reanimated'

// iOS's sheet curve: a quick start that settles gently, so a sheet arrives without a hard stop.
export const BOTTOM_DRAWER_EASING = Easing.bezier(0.32, 0.72, 0, 1)
export const BOTTOM_DRAWER_SHOW_DURATION_MS = 480
export const BOTTOM_DRAWER_HIDE_DURATION_MS = 300
/** Content that grows or shrinks inside a sheet eases on the same curve. */
export const BOTTOM_DRAWER_HEIGHT_DURATION_MS = 320
