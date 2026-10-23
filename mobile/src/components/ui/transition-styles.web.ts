import type { ViewStyle } from 'react-native'
import { motion } from '../../theme/mobile-theme'

// react-native-web compiles these to CSS; React Native's style types do not declare them.
type WebTransitionStyle = ViewStyle & {
  transitionProperty: string
  transitionDuration: string
  transitionTimingFunction: string
}

const PRESS_PROPERTIES = 'transform, background-color, opacity'

/** Web sibling: CSS takes the destination state's timing, so a press lands fast and eases back. */
export const pressTransition: { rest: WebTransitionStyle; pressed: WebTransitionStyle } = {
  rest: {
    cursor: 'pointer',
    transitionProperty: PRESS_PROPERTIES,
    transitionDuration: `${motion.pressOutMs}ms`,
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
  },
  pressed: {
    cursor: 'pointer',
    transitionProperty: PRESS_PROPERTIES,
    transitionDuration: `${motion.pressInMs}ms`,
    transitionTimingFunction: 'ease-out'
  }
}

/** A thumb or indicator moving between positions, on the sheet curve. */
export const slideTransition: WebTransitionStyle = {
  transitionProperty: 'transform, width, opacity',
  transitionDuration: '300ms',
  transitionTimingFunction: motion.sheetEasing
}
