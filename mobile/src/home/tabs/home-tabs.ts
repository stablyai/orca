import { Easing } from 'react-native-reanimated'

export type HomeTabId = 'feed' | 'agents' | 'usage' | 'automations' | 'settings'

export const HOME_TABS: readonly HomeTabId[] = [
  'feed',
  'agents',
  'usage',
  'automations',
  'settings'
]

/** Strong ease-out for things entering or reacting to a touch. */
export const HOME_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)
