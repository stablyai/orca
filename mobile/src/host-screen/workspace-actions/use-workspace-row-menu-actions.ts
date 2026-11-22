import {
  Bell,
  BellMinus,
  BellOff,
  BellRing,
  Bot,
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
import { folderIdOfSelector } from '../../../../src/shared/workspace/identity/workspace-scope'
import type { HostScreenController } from '../use-host-screen-controller'
import { useWorkspaceNotificationMutes } from './use-workspace-notification-mutes'

// worktree.set resolves git worktrees only, so these refuse a folder workspace's id.
const GIT_WORKTREE_ONLY_ACTIONS = new Set([
  'rename',
  'toggleRead',
  'togglePin',
  'moveToStatus',
  'handToBot'
])

/** The workspace row menu, in the desktop row menu's words. */
export function useWorkspaceRowMenuActions(args: {
  controller: HostScreenController
  row: Worktree | null
  server: ReturnType<typeof useWorkspaceServer>
  onRename: (row: Worktree) => void
  onMoveToStatus: (row: Worktree) => void
  /** Absent while this computer's Bots are off or unread. */
  onHandToBot: ((row: Worktree) => void) | null
}): ActionSheetAction[] {
  const { controller, row, server, onRename, onMoveToStatus, onHandToBot } = args
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
  const isFolder = folderIdOfSelector(row.worktreeId) !== undefined
  const menu: ActionSheetAction[] = [
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
    // A server's workspace would move under a bot on another computer, which only the desktop builds.
    ...(onHandToBot && !server.server
      ? [
          {
            id: 'handToBot',
            label: t('bots.handToBot.menu', 'Hand to bot…'),
            icon: Bot,
            onPress: () => onHandToBot(row)
          }
        ]
      : []),
    {
      id: 'delete',
      // Desktop's folder rows say Remove Workspace: the folder stays on disk.
      label: isFolder
        ? t('hostScreen.deleteConfirm.removeTitle', 'Remove Workspace')
        : t('common.delete', 'Delete'),
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
  return isFolder ? menu.filter((action) => !GIT_WORKTREE_ONLY_ACTIONS.has(action.id ?? '')) : menu
}
