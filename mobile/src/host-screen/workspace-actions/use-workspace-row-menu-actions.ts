import {
  Bell,
  BellMinus,
  BellOff,
  BellRing,
  Edit3,
  Kanban,
  Moon,
  Pin,
  PinOff
} from 'lucide-react-native'
import { buildWorktreeNavigationActions } from '../../agent-history/worktree-navigation-actions'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { useWorkspaceServer } from '../../worktree/execution-hosts/workspace-server'
import { isWorktreePinned } from '../../worktree/workspace-list/workspace-list-sections'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenController } from '../use-host-screen-controller'
import { useWorkspaceNotificationMutes } from './use-workspace-notification-mutes'

/** The workspace row menu, in the desktop row menu's words. */
export function useWorkspaceRowMenuActions(args: {
  controller: HostScreenController
  row: Worktree | null
  server: ReturnType<typeof useWorkspaceServer>
  onRename: (row: Worktree) => void
  onMoveToStatus: (row: Worktree) => void
}): ActionSheetAction[] {
  const { controller, row, server, onRename, onMoveToStatus } = args
  const { actions, client, connState, hostCapabilities, hostId, state } = controller
  const t = useMobileTranslation()
  const { mutes, setMuted } = useWorkspaceNotificationMutes({
    client,
    connState,
    menuOpen: row !== null
  })
  if (!row) {
    return []
  }
  const close = () => state.setActionTarget(null)
  const pinned = isWorktreePinned(row, state.pinnedIds)
  const muted = mutes?.[row.worktreeId] === true
  // A server row's writes go through the desktop; with that server unreachable they cannot land.
  const serverUnreachable =
    server.server !== null && (server.routeHost === null || server.server.state !== 'connected')
  return [
    ...buildWorktreeNavigationActions({
      hostId,
      worktreeId: row.worktreeId,
      worktreeName: row.displayName || row.repo,
      executionHost: server.routeHost,
      hostCapabilities: server.server?.gates.hostCapabilities ?? hostCapabilities,
      navigate: actions.navigateFromHostList,
      onDone: close
    }),
    {
      id: 'rename',
      label: t('hostScreen.hostScreenOverlays.rename', 'Rename'),
      icon: Edit3,
      onPress: () => onRename(row)
    },
    {
      id: 'sleep',
      label: t('hostScreen.hostScreenOverlays.sleep', 'Sleep'),
      icon: Moon,
      // Like desktop, greyed out with nothing to sleep; older hosts omit the fact.
      disabled: row.hasHostSidebarActivity === false || serverUnreachable,
      onPress: () => {
        actions.putWorktreeToSleep(row)
        close()
      }
    },
    {
      id: 'toggleRead',
      label: row.unread
        ? t('hostScreen.hostScreenOverlays.markRead', 'Mark Read')
        : t('hostScreen.hostScreenOverlays.markUnread', 'Mark Unread'),
      icon: row.unread ? BellOff : Bell,
      disabled: serverUnreachable,
      onPress: () => {
        actions.setWorktreeUnread(row, !row.unread)
        close()
      }
    },
    // Desktop's own mute list; a desktop too old to keep one offers none.
    ...(mutes
      ? [
          {
            id: 'toggleMute',
            label: muted
              ? t('hostScreen.hostScreenOverlays.unmuteNotifications', 'Unmute Notifications')
              : t('hostScreen.hostScreenOverlays.muteNotifications', 'Mute Notifications'),
            icon: muted ? BellRing : BellMinus,
            onPress: () => {
              setMuted(row.worktreeId, !muted)
              close()
            }
          }
        ]
      : []),
    {
      id: 'togglePin',
      label: pinned
        ? t('hostScreen.hostScreenOverlays.unpin', 'Unpin')
        : t('hostScreen.hostScreenOverlays.pin', 'Pin'),
      icon: pinned ? PinOff : Pin,
      onPress: () => {
        actions.togglePin(row)
        close()
      }
    },
    // A server row's columns are that server's own, which the desktop does not relay to the phone yet.
    ...(server.server
      ? []
      : [
          {
            id: 'moveToStatus',
            label: t('hostScreen.hostScreenOverlays.moveToStatus', 'Move to Status'),
            icon: Kanban,
            onPress: () => onMoveToStatus(row)
          }
        ]),
    {
      id: 'delete',
      label: t('common.delete', 'Delete'),
      destructive: true,
      onPress: () => state.setConfirmDelete(row),
      // Like desktop, git can't remove a primary checkout; older hosts omit the flag.
      ...(row.isMainWorktree === true
        ? {
            disabled: true,
            hint: t(
              'hostScreen.hostScreenOverlays.primaryWorktreeDeleteHint',
              "Primary worktree — can't be deleted. Remove the project instead."
            )
          }
        : {})
    }
  ]
}
