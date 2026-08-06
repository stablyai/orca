import { ListChecks } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  visible: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showAgentSessionHistory,
  showChecks,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: Props) {
  return (
    <ActionSheetModal
      visible={visible}
      actions={[
        ...(showAgentSessionHistory
          ? [
              {
                label: t('mobileSessionHeaderMoreActionsSheet.agent'),
                hint: t('mobileSessionHeaderMoreActionsSheet.browse'),
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
                label: t('mobileSessionHeaderMoreActionsSheet.checks'),
                hint: t('mobileSessionHeaderMoreActionsSheet.open'),
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
