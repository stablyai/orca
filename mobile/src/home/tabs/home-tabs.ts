import { Easing } from 'react-native-reanimated'

export type HomeTabId = 'feed' | 'bots' | 'agents' | 'usage' | 'automations'

export const HOME_TABS: readonly HomeTabId[] = ['feed', 'bots', 'agents', 'usage', 'automations']

export function isHomeTabId(value: unknown): value is HomeTabId {
  return HOME_TABS.some((tab) => tab === value)
}

/** Strong ease-out for things entering or reacting to a touch. */
export const HOME_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)
