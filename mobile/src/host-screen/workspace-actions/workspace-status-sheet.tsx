import { Circle } from 'lucide-react-native'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/worktree/types'
import { getWorkspaceStatus } from '../../../../src/shared/workspace/status/workspace-statuses'
import { ActionSheetContent } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

// Swapped into the workspace menu's open drawer, like desktop's Move to Status submenu.
export function WorkspaceStatusSheet({
  row,
  statuses,
  onPick,
  onClose
}: {
  row: Worktree
  statuses: readonly WorkspaceStatusDefinition[]
  onPick: (row: Worktree, statusId: string) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const current = getWorkspaceStatus(row, statuses)
  return (
    <ActionSheetContent
      title={t('hostScreen.hostScreenOverlays.status', 'Status')}
      actions={statuses.map((status) => ({
        id: status.id,
        label: status.label,
        icon: Circle,
        checked: status.id === current,
        // Always written: the menu's row may predate a status change made elsewhere.
        onPress: () => {
          onPick(row, status.id)
          onClose()
        }
      }))}
    />
  )
}
