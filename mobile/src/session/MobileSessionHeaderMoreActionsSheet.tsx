import { useState } from 'react'
import { ListChecks } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { colors } from '../theme/mobile-theme'

type Props = {
  visible: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  showDelete: boolean
  deleteDisabled: boolean
  worktreeName: string
  isFolderWorkspace: boolean
  onDelete: () => void
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showAgentSessionHistory,
  showChecks,
  showDelete,
  deleteDisabled,
  worktreeName,
  isFolderWorkspace,
  onDelete,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <>
      <ActionSheetModal
        visible={visible}
        actions={[
          ...(showAgentSessionHistory
            ? [
                {
                  label: 'Agent History',
                  hint: 'Browse and resume agent sessions',
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
                  label: 'Checks',
                  hint: 'Open pull request checks',
                  icon: ListChecks,
                  onPress: onOpenChecks
                }
              ]
            : []),
          ...(showDelete
            ? [
                {
                  label: 'Delete',
                  destructive: true,
                  disabled: deleteDisabled,
                  closeBeforePress: true,
                  onPress: () => setConfirmDelete(true)
                }
              ]
            : [])
        ]}
        onClose={onClose}
      />
      <ConfirmModal
        visible={confirmDelete}
        title={isFolderWorkspace ? 'Delete Workspace' : 'Delete Worktree'}
        message={`Delete "${worktreeName}"?`}
        confirmLabel="Delete"
        destructive
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
