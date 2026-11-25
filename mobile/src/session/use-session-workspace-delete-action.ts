import { useEffect, useRef } from 'react'
import { useNavigation } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react-native'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import { canonicalExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { useHostBotsEntry } from '../bots/host-bot-store'
import { hostBotsKey } from '../bots/host-bots-read'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { cachedHostWorktrees } from '../host-screen/catalog/host-list-queries'
import {
  findHostListDeleteRow,
  HOST_LIST_DELETE_PARAM,
  requestHostListDelete,
  type HostListDeleteTarget
} from '../host-screen/workspace-actions/host-list-delete-intent'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostListInThisDocument } from '../navigation/host-list-in-document'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useRouteCapability } from '../worktree/execution-hosts/use-workspace-client'
import type { MobileSessionController } from './use-mobile-session-controller'

type LiveDelete = { key: string; target: HostListDeleteTarget; allowed: boolean } | null

function deleteKey(target: HostListDeleteTarget): string {
  return `${target.hostId}\n${target.owner}\n${target.worktreeId}`
}

/** The session menu's Delete Workspace: hands the delete to the host list's own confirm. */
export function useSessionWorkspaceDeleteAction(
  controller: MobileSessionController
): ActionSheetAction[] {
  const t = useMobileTranslation()
  const {
    hostId,
    worktreeId,
    worktreeHostId,
    connState,
    routeBot,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    showHeaderMoreActions,
    router,
    requestLeaveForHandoff
  } = controller
  const navigation = useNavigation()
  const queryClient = useQueryClient()
  const executionHost = useWorkspaceExecutionHost()
  const hostListHere = useHostListInThisDocument(hostId)
  const botsOnPhone = useRouteCapability(BOTS_MOBILE_RUNTIME_CAPABILITY)
  const botsEntry = useHostBotsEntry(isFolderWorkspaceRoute ? hostBotsKey(hostId) : null)
  // The checkout's own host, as the session read it; a server's rows can't prove theirs, so none is offered.
  const owner = executionHost === undefined ? canonicalExecutionHostId(worktreeHostId) : null
  const target: HostListDeleteTarget | null =
    hostListHere && !isFloatingWorkspaceRoute && routeBot === null && owner
      ? { hostId, owner, worktreeId }
      : null
  // A folder may be a bot's home until this host's bots are read; the list checks again before confirming.
  const homeUnknown = isFolderWorkspaceRoute && botsOnPhone && botsEntry === null
  // The cached list row, read only while the menu is open; a host that hasn't said leaves it enabled.
  const primaryCheckout =
    showHeaderMoreActions &&
    target !== null &&
    findHostListDeleteRow(cachedHostWorktrees(queryClient, hostId) ?? [], target)
      ?.isMainWorktree === true
  const allowed = target !== null && connState === 'connected' && !homeUnknown && !primaryCheckout

  // The press runs after the menu has slid away; it acts only on what is still true then.
  const liveRef = useRef<LiveDelete>(null)
  const live: LiveDelete = target ? { key: deleteKey(target), target, allowed } : null
  useEffect(() => {
    liveRef.current = live
  })
  useEffect(
    () => () => {
      liveRef.current = null
    },
    []
  )
  const stillAllowed = (key: string): HostListDeleteTarget | null => {
    const current = liveRef.current
    return current && current.key === key && current.allowed && navigation.isFocused()
      ? current.target
      : null
  }

  if (!target) {
    return []
  }
  const key = deleteKey(target)
  return [
    {
      id: 'deleteWorkspace',
      // Desktop's folder rows say Remove Workspace: the folder stays on disk.
      label: isFolderWorkspaceRoute
        ? t('hostScreen.deleteConfirm.removeTitle', 'Remove Workspace')
        : t('hostScreen.deleteConfirm.deleteTitle', 'Delete Workspace'),
      icon: Trash2,
      destructive: true,
      disabled: !allowed,
      ...(primaryCheckout
        ? {
            hint: t(
              'hostScreen.hostScreenOverlays.primaryWorktreeDeleteHint',
              "Primary worktree — can't be deleted. Remove the project instead."
            )
          }
        : {}),
      closeBeforePress: true,
      onPress: () => {
        if (!stillAllowed(key)) {
          return
        }
        // Unsaved phone drafts get the same Copy/Discard choice as Back; cancelling arms nothing.
        requestLeaveForHandoff(() => {
          const current = stillAllowed(key)
          if (!current) {
            return
          }
          const token = requestHostListDelete(current)
          router.dismissTo(
            `/h/${encodeURIComponent(hostId)}?${HOST_LIST_DELETE_PARAM}=${encodeURIComponent(token)}`
          )
        })
      }
    }
  ]
}
