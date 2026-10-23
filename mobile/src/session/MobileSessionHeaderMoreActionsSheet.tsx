import { Folder, ListChecks, SquareChevronRight } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'

type Props = {
  visible: boolean
  showFiles: boolean
  /** On wide layouts the files panel docks; the row then closes it. */
  filesDocked: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  checksDocked: boolean
  quickCommandsDisabled: boolean
  /** Null while the desktop's capabilities are still being read. */
  quickCommandsSupported: boolean | null
  onOpenFiles: () => void
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onShowQuickCommands: () => void
  onToast: (message: string, durationMs?: number) => void
  onClose: () => void
}

/** The session bar's overflow: everything about the workspace that is not a tab or source control. */
export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showFiles,
  filesDocked,
  showAgentSessionHistory,
  showChecks,
  checksDocked,
  quickCommandsDisabled,
  quickCommandsSupported,
  onOpenFiles,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onShowQuickCommands,
  onToast,
  onClose
}: Props) {
  // Why: old hosts must stay gated because they strip agentPrompt.
  const openQuickCommands = () => {
    if (quickCommandsSupported === true) {
      onShowQuickCommands()
      return
    }
    onToast(
      quickCommandsSupported === false
        ? 'Update Orca on your desktop to use quick commands.'
        : 'Checking what your desktop supports. Try again in a moment.',
      2400
    )
  }
  const actions: ActionSheetAction[] = [
    ...(showFiles
      ? [{ label: filesDocked ? 'Hide files' : 'Files', icon: Folder, onPress: onOpenFiles }]
      : []),
    {
      label: 'Quick commands',
      hint: 'Run a saved command or agent prompt',
      icon: SquareChevronRight,
      disabled: quickCommandsDisabled,
      // Why: the quick commands sheet can only present once this one has gone.
      closeBeforePress: true,
      onPress: openQuickCommands
    },
    ...(showAgentSessionHistory
      ? [
          {
            label: 'Agent history',
            hint: 'Browse and resume agent sessions',
            renderIcon: () => (
              <MobileAgentSessionHistoryIcon
                size={20}
                color={colors.textSecondary}
                strokeWidth={2}
              />
            ),
            onPress: onOpenAgentSessionHistory
          }
        ]
      : []),
    ...(showChecks
      ? [
          {
            label: checksDocked ? 'Hide checks' : 'Checks',
            hint: 'Pull request checks and reviews',
            icon: ListChecks,
            onPress: onOpenChecks
          }
        ]
      : [])
  ]
  return <ActionSheetModal visible={visible} actions={actions} onClose={onClose} />
}
