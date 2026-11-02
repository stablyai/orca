import { useWindowDimensions } from 'react-native'

// iOS "xxxLarge" (1.35) and up: a label plus two buttons no longer fit one line of a small phone.
const LARGE_TEXT_FONT_SCALE = 1.3

/** True at the system's larger text sizes, where a row's buttons move to a line of their own. */
export function useLargeSystemText(): boolean {
  return useWindowDimensions().fontScale > LARGE_TEXT_FONT_SCALE
}
