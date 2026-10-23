import type { ViewStyle } from 'react-native'

/** Native half: presses and slides snap, as UIKit highlights do. The web sibling eases them. */
export const pressTransition: { rest: ViewStyle; pressed: ViewStyle } = { rest: {}, pressed: {} }
export const slideTransition: ViewStyle = {}
