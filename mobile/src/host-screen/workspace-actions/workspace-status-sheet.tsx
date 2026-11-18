import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react-native'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../src/shared/workspace/status/workspace-status-defaults'
import {
  getWorkspaceStatus,
  withDefaultWorkspaceStatuses
} from '../../../../src/shared/workspace/status/workspace-statuses'
import { ActionSheetContent } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { workspaceStatusColumnsRead } from './workspace-row-menu-operations'

/** A server row moves among that server's own columns, as on desktop; the desktop's rows use the list's. */
function useRowStatusColumns(
  row: Worktree,
  desktopStatuses: readonly WorkspaceStatusDefinition[],
  serverClient: RpcClient | null
): readonly WorkspaceStatusDefinition[] | null {
  const [serverStatuses, setServerStatuses] = useState<readonly WorkspaceStatusDefinition[] | null>(
    null
  )
  useEffect(() => {
    if (!serverClient) {
      return
    }
    let current = true
    void workspaceStatusColumnsRead
      .request(serverClient)
      .then((reply) => {
        const read = workspaceStatusColumnsRead.interpret(reply)
        return read.accepted ? (read.value.workspaceStatuses ?? []) : []
      })
      .catch(() => [])
      .then((statuses) => {
        if (current) {
          setServerStatuses(withDefaultWorkspaceStatuses(statuses))
        }
      })
    return () => {
      current = false
    }
  }, [serverClient])
  if (!row.hostId?.startsWith('runtime:')) {
    return desktopStatuses
  }
  return serverClient ? serverStatuses : DEFAULT_WORKSPACE_STATUSES
}

// Swapped into the workspace menu's open drawer, like desktop's Move to Status submenu.
export function WorkspaceStatusSheet({
  row,
  desktopStatuses,
  serverClient,
  onPick,
  onClose
}: {
  row: Worktree
  desktopStatuses: readonly WorkspaceStatusDefinition[]
  /** The row's server, for a server row; null for the desktop's own rows. */
  serverClient: RpcClient | null
  onPick: (row: Worktree, statusId: string) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const statuses = useRowStatusColumns(row, desktopStatuses, serverClient)
  const current = statuses ? getWorkspaceStatus(row, statuses) : null
  return (
    <ActionSheetContent
      title={t('hostScreen.hostScreenOverlays.moveToStatus', 'Move to Status')}
      actions={(statuses ?? []).map((status) => ({
        id: status.id,
        label: status.label,
        icon: Circle,
        checked: status.id === current,
        onPress: () => {
          if (status.id !== current) {
            onPick(row, status.id)
          }
          onClose()
        }
      }))}
    />
  )
}
