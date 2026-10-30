import { ListChecks } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import type { RecentSessionCardRecord } from './recent-session-cards'
import { RecentSessionCardsSection } from './RecentSessionCardsSheet'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type MobileSessionHeaderMoreActionsSheetProps = {
  visible: boolean
  showRecentSessionCards?: boolean
  recentSessionCards?: readonly RecentSessionCardRecord[]
  jumpingRecentCardKey?: string | null
  currentWorktreeId?: string
  currentTabId?: string | null
  onSelectRecentSessionCard?: (card: RecentSessionCardRecord) => void
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showRecentSessionCards,
  recentSessionCards,
  jumpingRecentCardKey,
  currentWorktreeId,
  currentTabId,
  onSelectRecentSessionCard,
  showAgentSessionHistory,
  showChecks,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: MobileSessionHeaderMoreActionsSheetProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <ActionSheetModal
      visible={visible}
      actions={[
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
    >
      {showRecentSessionCards && onSelectRecentSessionCard ? (
        <RecentSessionCardsSection
          cards={recentSessionCards ?? []}
          jumpingCardKey={jumpingRecentCardKey ?? null}
          currentWorktreeId={currentWorktreeId}
          currentTabId={currentTabId}
          onSelectCard={onSelectRecentSessionCard}
        />
      ) : null}
    </ActionSheetModal>
  )
}
