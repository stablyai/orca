import { useEffect, useState } from 'react'
import { Circle } from 'lucide-react-native'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/worktree/types'
import {
  getWorkspaceStatus,
  withDefaultWorkspaceStatuses
} from '../../../../src/shared/workspace/status/workspace-statuses'
import { ActionSheetContent } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { workspaceStatusColumnsRead } from './workspace-row-menu-operations'

type StatusColumns = readonly WorkspaceStatusDefinition[] | 'loading' | 'unreadable'

/** A server row moves among that server's own columns, as on desktop; the desktop's rows use the list's. */
function useRowStatusColumns(
  row: Worktree,
  desktopStatuses: readonly WorkspaceStatusDefinition[],
  serverClient: RpcClient | null
): StatusColumns {
  const [serverStatuses, setServerStatuses] = useState<StatusColumns>('loading')
  useEffect(() => {
    if (!serverClient) {
      return
    }
    let current = true
    void workspaceStatusColumnsRead
      .request(serverClient)
      .then((reply) => {
        const read = workspaceStatusColumnsRead.interpret(reply)
        // An empty list is the server's defaults; a failed read must not offer columns it may not have.
        return read.accepted
          ? withDefaultWorkspaceStatuses(read.value.workspaceStatuses ?? [])
          : null
      })
      .catch(() => null)
      .then((statuses) => {
        if (current) {
          setServerStatuses(statuses ?? 'unreadable')
        }
      })
    return () => {
      current = false
    }
  }, [serverClient])
  if (!row.hostId?.startsWith('runtime:')) {
    return desktopStatuses
  }
  return serverClient ? serverStatuses : 'unreadable'
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
  const columns = useRowStatusColumns(row, desktopStatuses, serverClient)
  const statuses = typeof columns === 'string' ? [] : columns
  const current = statuses.length > 0 ? getWorkspaceStatus(row, statuses) : null
  return (
    <ActionSheetContent
      title={t('hostScreen.hostScreenOverlays.moveToStatus', 'Move to Status')}
      message={
        columns === 'unreadable'
          ? t(
              'hostScreen.hostScreenOverlays.statusesUnreadable',
              "Couldn't read this server's statuses. Try again in a moment."
            )
          : undefined
      }
      actions={statuses.map((status) => ({
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
