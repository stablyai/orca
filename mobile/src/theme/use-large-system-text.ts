import { useWindowDimensions } from 'react-native'

// iOS "xxxLarge" (1.35) and up: a label plus two buttons no longer fit one line of a small phone.
const LARGE_TEXT_FONT_SCALE = 1.3

export function useLargeSystemText(): boolean {
  return useWindowDimensions().fontScale > LARGE_TEXT_FONT_SCALE
}
