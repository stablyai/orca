import { ListChecks } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  visible: boolean
  additionalActions?: ActionSheetAction[]
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  additionalActions,
  showAgentSessionHistory,
  showChecks,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <ActionSheetModal
      visible={visible}
      actions={[
        ...(additionalActions ?? []),
        ...(showAgentSessionHistory
          ? [
              {
                id: 'agentHistory',
                label: t('session.headerMoreActionsSheet.agentHistory', 'Agent History'),
                hint: t(
                  'session.headerMoreActionsSheet.agentHistoryHint',
                  'Browse and resume agent sessions'
                ),
                renderIcon: () => (
                  <MobileAgentSessionHistoryIcon
                    size={16}
                    color={colors.textSecondary}
                    strokeWidth={2.1}
                  />
                ),
                onPress: onOpenAgentSessionHistory
              }
            ]
          : []),
        ...(showChecks
          ? [
              {
                id: 'checks',
                label: t('session.headerMoreActionsSheet.checks', 'Checks'),
                hint: t('session.headerMoreActionsSheet.checksHint', 'Open pull request checks'),
                icon: ListChecks,
                onPress: onOpenChecks
              }
            ]
          : [])
      ]}
      onClose={onClose}
    />
  )
}
