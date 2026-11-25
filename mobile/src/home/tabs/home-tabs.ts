import { Easing } from 'react-native-reanimated'
import {
  Bot,
  CalendarClock,
  Gauge,
  LayoutList,
  SquareTerminal,
  type AppIcon
} from '../../components/icons/app-icons'
import type { Translate } from '../../i18n/mobile-i18n'

export type HomeTabId = 'feed' | 'bots' | 'agents' | 'usage' | 'automations'

export const HOME_TABS: readonly HomeTabId[] = ['feed', 'bots', 'agents', 'usage', 'automations']

export const HOME_TAB_ICONS: Record<HomeTabId, AppIcon> = {
  feed: LayoutList,
  bots: Bot,
  agents: SquareTerminal,
  usage: Gauge,
  automations: CalendarClock
}

export function homeTabLabels(t: Translate): Record<HomeTabId, string> {
  return {
    feed: t('home.tabs.feed', 'Feed'),
    bots: t('home.tabs.bots', 'Bots'),
    agents: t('home.tabs.agents', 'Agents'),
    usage: t('home.tabs.usage', 'Usage'),
    automations: t('home.tabs.automations', 'Automations')
  }
}

/** Strong ease-out for things entering or reacting to a touch. */
export const HOME_EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1)
