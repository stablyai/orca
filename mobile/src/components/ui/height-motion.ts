import { Easing } from 'react-native-reanimated'

/** One curve for every height change, the same as the sheets', so expanding things feel related. */
export const HEIGHT_EASING = Easing.bezier(0.32, 0.72, 0, 1)
export const HEIGHT_DURATION_MS = 320
