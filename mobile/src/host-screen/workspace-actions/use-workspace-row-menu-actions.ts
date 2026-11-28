import {
  BellMinus,
  BellRing,
  Bot,
  CircleDashed,
  Edit3,
  Eye,
  EyeOff,
  Moon,
  Pin,
  PinOff,
  Smartphone
} from 'lucide-react-native'
import { DELEGATED_PHONE_SERVER_OFFER_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/pairing/delegated-phone-server-offer-contract'
import { useServerOwnPairingRequest } from './server-own-pairing'
import { BRIDGE_MAX_ROUTE_HREF_CHARS } from '../../mobile-web-shell/bridge/protocol/bridge-caps'
import { buildWorktreeNavigationActions } from '../../agent-history/worktree-navigation-actions'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { useWorkspaceServer } from '../../worktree/execution-hosts/workspace-server'
import { isWorktreePinned } from '../../worktree/workspace-list/workspace-list-sections'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { folderIdOfSelector } from '../../../../src/shared/workspace/identity/workspace-scope'
import { getWorkspaceStatus } from '../../../../src/shared/workspace/status/workspace-statuses'
import type { HostScreenController } from '../use-host-screen-controller'
import { useWorkspaceNotificationMutes } from './use-workspace-notification-mutes'

// worktree.set resolves git worktrees only, so these refuse a folder workspace's id.
const GIT_WORKTREE_ONLY_ACTIONS = new Set(['rename', 'toggleRead', 'togglePin', 'moveToStatus'])

/** The workspace's long-press sheet: go somewhere, quick toggles, changes, then endings. Actions
 *  that can't run here are left out rather than greyed. */
export function useWorkspaceRowMenuActions(args: {
  controller: HostScreenController
  row: Worktree | null
  server: ReturnType<typeof useWorkspaceServer>
  onRename: (row: Worktree) => void
  onMoveToStatus: (row: Worktree) => void
  /** Absent while this computer's Bots are off or unread. */
  onHandToBot: ((row: Worktree) => void) | null
  /** Both hand-offs are offered: the one Hand off row asks which. */
  onChooseHandOff: (choices: ActionSheetAction[]) => void
}): ActionSheetAction[] {
  const { controller, row, server, onRename, onMoveToStatus, onHandToBot, onChooseHandOff } = args
  const { actions, client, connState, hostCapabilities, hostId, state } = controller
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { mutes, setMuted } = useWorkspaceNotificationMutes({
    client,
    connState,
    menuOpen: row !== null
  })
  const ownPairingRequest = useServerOwnPairingRequest(row?.worktreeId ?? null)
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
  const serverOwnPairing = serverOwnPairingAction({
    controller,
    server,
    close,
    t,
    request: ownPairingRequest
  })
  const navigation = buildWorktreeNavigationActions({
    hostId,
    worktreeId: row.worktreeId,
    worktreeName: row.displayName || row.repo,
    executionHost: server.routeHost,
    hostCapabilities: server.server?.gates.hostCapabilities ?? hostCapabilities,
    navigate: actions.navigateFromHostList,
    onDone: close,
    t,
    colors
  })
  // One Hand off: to an agent (picked from history) or, from a desktop row, to a bot.
  const handOffChoices: ActionSheetAction[] = [
    ...navigation
      .filter((action) => action.id === 'handoffAgentSession')
      .map((action) => ({
        ...action,
        label: t('hostScreen.hostScreenOverlays.handOffToAgent', 'To an agent'),
        group: undefined
      })),
    // A server's workspace would move under a bot on another computer, which only the desktop
    // builds; a folder workspace can't be handed to a bot (worktree.set refuses its id).
    ...(onHandToBot && !server.server && !isFolder
      ? [
          {
            id: 'handToBot',
            label: t('hostScreen.hostScreenOverlays.handOffToBot', 'To a bot'),
            icon: Bot,
            onPress: () => onHandToBot(row)
          }
        ]
      : [])
  ]
  const handOffLabel = t('hostScreen.hostScreenOverlays.handOff', 'Hand off')
  const handOff: ActionSheetAction[] =
    handOffChoices.length === 0
      ? []
      : [
          {
            ...handOffChoices[0],
            id: 'handOff',
            label: handOffLabel,
            icon: Bot,
            renderIcon: undefined,
            navigates: true,
            ...(handOffChoices.length > 1
              ? { skipAutoClose: true, onPress: () => onChooseHandOff(handOffChoices) }
              : {})
          }
        ]
  const statuses = state.view.workspaceStatuses
  const statusId = getWorkspaceStatus(row, statuses)
  const status = server.server
    ? null
    : (statuses.find((definition) => definition.id === statusId)?.label ?? '')
  const menu: ActionSheetAction[] = [
    ...navigation
      .filter((action) => action.id !== 'handoffAgentSession')
      .map((action) => ({ ...action, group: 'open', navigates: true })),
    ...handOff.map((action) => ({ ...action, group: 'open' })),
    {
      id: 'toggleRead',
      group: 'toggles',
      label: row.unread
        ? t('hostScreen.hostScreenOverlays.markRead', 'Mark as read')
        : t('hostScreen.hostScreenOverlays.markUnread', 'Mark as unread'),
      icon: row.unread ? Eye : EyeOff,
      disabled: serverUnreachable,
      onPress: () => {
        actions.setWorktreeUnread(row, !row.unread)
        close()
      }
    },
    {
      id: 'togglePin',
      group: 'toggles',
      label: pinned
        ? t('hostScreen.hostScreenOverlays.unpin', 'Unpin')
        : t('hostScreen.hostScreenOverlays.pin', 'Pin'),
      icon: pinned ? PinOff : Pin,
      onPress: () => {
        actions.togglePin(row)
        close()
      }
    },
    // Desktop's own mute list; a desktop too old to keep one offers none.
    ...(mutes
      ? [
          {
            id: 'toggleMute',
            group: 'toggles',
            label: muted
              ? t('hostScreen.hostScreenOverlays.unmuteNotifications', 'Unmute notifications')
              : t('hostScreen.hostScreenOverlays.muteNotifications', 'Mute notifications'),
            icon: muted ? BellRing : BellMinus,
            onPress: () => {
              setMuted(row.worktreeId, !muted)
              close()
            }
          }
        ]
      : []),
    {
      id: 'rename',
      group: 'change',
      label: t('hostScreen.hostScreenOverlays.rename', 'Rename'),
      icon: Edit3,
      onPress: () => onRename(row)
    },
    ...serverOwnPairing,
    // A server row's columns are that server's own, which the desktop does not relay to the phone yet.
    ...(status === null
      ? []
      : [
          {
            id: 'moveToStatus',
            group: 'change',
            label: t('hostScreen.hostScreenOverlays.status', 'Status'),
            status,
            navigates: true,
            icon: CircleDashed,
            onPress: () => onMoveToStatus(row)
          }
        ]),
    // Like desktop, nothing to sleep hides it; older hosts omit the fact.
    ...(row.hasHostSidebarActivity === false || serverUnreachable
      ? []
      : [
          {
            id: 'sleep',
            group: 'end',
            label: t('hostScreen.hostScreenOverlays.sleep', 'Sleep'),
            icon: Moon,
            onPress: () => {
              actions.putWorktreeToSleep(row)
              close()
            }
          }
        ]),
    // Git can't remove a primary checkout; older hosts omit the flag.
    ...(row.isMainWorktree === true
      ? []
      : [
          {
            id: 'delete',
            group: 'end',
            // Desktop's folder rows say Remove workspace: the folder stays on disk.
            label: isFolder
              ? t('hostScreen.deleteConfirm.removeTitle', 'Remove workspace')
              : t('common.delete', 'Delete'),
            destructive: true,
            onPress: () => state.setConfirmDelete(row)
          }
        ])
  ]
  return isFolder ? menu.filter((action) => !GIT_WORKTREE_ONLY_ACTIONS.has(action.id ?? '')) : menu
}

// A server the desktop relays can pair this phone itself, so the phone keeps reaching it while the
// desktop sleeps. Offered only by servers that mint such pairings; an older desktop says to update.
function serverOwnPairingAction(args: {
  controller: HostScreenController
  server: ReturnType<typeof useWorkspaceServer>
  close: () => void
  t: ReturnType<typeof useMobileTranslation>
  request: ReturnType<typeof useServerOwnPairingRequest>
}): ActionSheetAction[] {
  const { controller, server, close, t, request } = args
  const target = server.server
  if (
    !target?.client ||
    target.state !== 'connected' ||
    !target.gates.hostCapabilities.includes(DELEGATED_PHONE_SERVER_OFFER_RUNTIME_CAPABILITY)
  ) {
    return []
  }
  const serverClient = target.client
  const serverName = target.name ?? t('hostScreen.serverOwnPairing.thisServer', 'this server')
  const desktopName = controller.state.hostName
  return [
    {
      id: 'keepServerReachable',
      group: 'change',
      label: t('hostScreen.serverOwnPairing.keepReachable', 'Keep {{server}} reachable', {
        server: serverName
      }),
      hint: t('hostScreen.serverOwnPairing.evenWhenAsleep', 'Even when {{desktop}} sleeps', {
        desktop: desktopName
      }),
      icon: Smartphone,
      navigates: true,
      // Minting can wait on the server's Relay; the sheet stays up until it answers.
      loading: request.pending,
      skipAutoClose: true,
      onPress: () => {
        if (request.pending) {
          return
        }
        request.start({ serverClient, serverName, desktopName, t }, (answer) => {
          close()
          if (answer.kind === 'pair') {
            const confirm = `/pair-confirm?code=${encodeURIComponent(answer.code)}`
            const named = `${confirm}&server=${encodeURIComponent(serverName)}`
            // The name is a nicety: a long one must not push the link past the bridge's cap.
            controller.actions.navigateFromHostList(
              named.length <= BRIDGE_MAX_ROUTE_HREF_CHARS ? named : confirm
            )
          } else {
            controller.state.setActionError(answer.message)
          }
        })
      }
    }
  ]
}
