import { Bot } from 'lucide-react-native'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import type { Translate } from '../../i18n/mobile-i18n'
import type { MobileNewTabAgentLoadState } from './mobile-agent-load-state'

/** The inert row a sheet shows in place of its agents while they load, or when there are none. */
export function mobileAgentLoadStatusRow(args: {
  loadState: MobileNewTabAgentLoadState
  optionCount: number
  errorHint: string
  t: Translate
}): ActionSheetAction | null {
  const { loadState, t } = args
  if (loadState === 'loading') {
    return {
      id: 'detectingAgents',
      label: t('session.usePanelRouteActions.detectingAgents', 'Detecting Agents'),
      icon: Bot,
      disabled: true,
      loading: true,
      onPress: () => {}
    }
  }
  if (args.optionCount > 0) {
    return null
  }
  switch (loadState) {
    case 'loaded':
      return {
        id: 'noEnabledAgents',
        label: t('session.usePanelRouteActions.noEnabledAgents', 'No Enabled Agents'),
        icon: Bot,
        disabled: true,
        onPress: () => {}
      }
    case 'other-runtime':
      return {
        id: 'otherServerAgents',
        label: t('session.usePanelRouteActions.otherServerAgents', 'Agents on Another Server'),
        hint: t('session.usePanelRouteActions.pairServerHint', 'Pair that server directly'),
        icon: Bot,
        disabled: true,
        onPress: () => {}
      }
    case 'error':
      return {
        id: 'presetsUnavailable',
        label: t('session.usePanelRouteActions.presetsUnavailable', 'Agent Presets Unavailable'),
        hint: args.errorHint,
        icon: Bot,
        disabled: true,
        onPress: () => {}
      }
    case 'idle':
      return null
  }
}
