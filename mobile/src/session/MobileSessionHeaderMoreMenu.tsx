import type { RefObject } from 'react'
import type { HostInstance } from 'react-native'
import {
  ALargeSmall,
  Columns2,
  Folder,
  GitBranch,
  ListChecks,
  Plus,
  SquareChevronRight,
  Trash2
} from 'lucide-react-native'
import { useQueryClient } from '@tanstack/react-query'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { getMobileNativeChatCliForkActions } from './native-chat/history/mobile-native-chat-cli-fork'
import {
  useWorkspaceExecutionHost,
  useWorkspaceOnPairedHost
} from '../navigation/workspace-execution-host'
import { useHostListInThisDocument } from '../navigation/host-list-in-document'
import { cachedHostWorktrees } from '../host-screen/catalog/host-list-queries'
import {
  findHostListDeleteRow,
  HOST_LIST_DELETE_PARAM,
  requestHostListDelete
} from '../host-screen/workspace-actions/host-list-delete-intent'

type Props = {
  controller: MobileSessionController
  anchorRef: RefObject<HostInstance | null>
  /** A narrow sideways header also moves source control and New tab in here. */
  actionsCollapsed: boolean
}

export function MobileSessionHeaderMoreMenu({ controller, anchorRef, actionsCollapsed }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    showAgentSessionHistoryAction,
    showChecksAction,
    openAgentSessionHistory,
    handlePanelTap,
    canSplitTerminals,
    terminalSplitActive,
    setShowTerminalLayout,
    setTextSizeSheet,
    showNativeChat,
    activeSessionTab,
    connState,
    createTabBusy,
    handleOpenNewTab,
    handleOpenQuickCommands,
    itemsOnPhone,
    hostId,
    worktreeId,
    routeBot,
    router
  } = controller
  const workspaceOnPairedHost = useWorkspaceOnPairedHost()
  const executionHost = useWorkspaceExecutionHost()
  const queryClient = useQueryClient()
  const hostListHere = useHostListInThisDocument(hostId)
  const tabActionsDisabled = createTabBusy || connState !== 'connected'
  const panels: ActionSheetAction[] = [
    ...(!isFloatingWorkspaceRoute
      ? [
          {
            id: 'files',
            label: t('session.header.fileExplorer', 'File explorer'),
            icon: Folder,
            closeBeforePress: true,
            onPress: () => handlePanelTap('files')
          }
        ]
      : []),
    // A bot's screen has no source control, even folded into ⋯.
    ...(actionsCollapsed && !isFloatingWorkspaceRoute && !itemsOnPhone
      ? [
          {
            id: 'sourceControl',
            label: t('session.header.sourceControl', 'Source control'),
            icon: GitBranch,
            closeBeforePress: true,
            onPress: () => handlePanelTap('sourceControl')
          }
        ]
      : []),
    ...(showChecksAction
      ? [
          {
            id: 'checks',
            label: t('session.headerMoreActionsSheet.checks', 'Checks'),
            hint: t('session.headerMoreActionsSheet.checksHint', 'Open pull request checks'),
            icon: ListChecks,
            onPress: () => handlePanelTap('pr')
          }
        ]
      : []),
    ...(showAgentSessionHistoryAction
      ? [
          {
            id: 'agentHistory',
            label: t('session.headerMoreActionsSheet.agentHistory', 'Agent History'),
            hint: t(
              'session.headerMoreActionsSheet.agentHistoryHint',
              'Browse and resume agent sessions'
            ),
            renderIcon: () => (
              <MobileAgentSessionHistoryIcon size={17} color={colors.textPrimary} strokeWidth={2} />
            ),
            onPress: openAgentSessionHistory
          }
        ]
      : []),
    // Desktop hides quick commands where there is no repo to run them in.
    ...(!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute
      ? [
          {
            id: 'quickCommands',
            label: t('session.header.quickCommands', 'Quick commands'),
            icon: SquareChevronRight,
            disabled: tabActionsDisabled,
            closeBeforePress: true,
            onPress: handleOpenQuickCommands
          }
        ]
      : [])
  ]
  const textSizeSheet = showNativeChat
    ? 'chat'
    : activeSessionTab?.type === 'terminal'
      ? 'terminal'
      : null
  const view: ActionSheetAction[] = [
    ...(canSplitTerminals || terminalSplitActive
      ? [
          {
            id: 'terminalLayout',
            label: t('session.header.terminalLayout', 'Terminal layout'),
            icon: Columns2,
            closeBeforePress: true,
            onPress: () => setShowTerminalLayout(true)
          }
        ]
      : []),
    ...(textSizeSheet
      ? [
          {
            id: 'textSize',
            label: t('session.header.textSize', 'Text size'),
            icon: ALargeSmall,
            closeBeforePress: true,
            onPress: () => setTextSizeSheet(textSizeSheet)
          }
        ]
      : [])
  ]
  const tabs: ActionSheetAction[] = [
    ...getMobileNativeChatCliForkActions({
      controller,
      tab: activeSessionTab?.type === 'agent-session' ? activeSessionTab : null,
      workspaceOnPairedHost,
      onDismiss: () => setShowHeaderMoreActions(false)
    }).map((action) => ({ ...action, disabled: tabActionsDisabled })),
    ...(actionsCollapsed
      ? [
          {
            id: 'newTab',
            label: t('session.header.newTab', 'New tab'),
            icon: Plus,
            disabled: tabActionsDisabled,
            closeBeforePress: true,
            onPress: handleOpenNewTab
          }
        ]
      : [])
  ]
  // Delete hands off to the host list's own confirm, so it is offered only where that list opens in
  // this document. A floating workspace has no row; a bot's home is removed from its bot.
  const deleteTarget =
    hostListHere && !isFloatingWorkspaceRoute && routeBot === null
      ? { hostId, executionHost, worktreeId }
      : null
  // The cached list row, read only while the menu is open; a host that hasn't said leaves it enabled.
  const primaryCheckout =
    showHeaderMoreActions &&
    deleteTarget !== null &&
    findHostListDeleteRow(cachedHostWorktrees(queryClient, hostId) ?? [], deleteTarget)
      ?.isMainWorktree === true
  const workspace: ActionSheetAction[] = deleteTarget
    ? [
        {
          id: 'deleteWorkspace',
          // Desktop's folder rows say Remove Workspace: the folder stays on disk.
          label: isFolderWorkspaceRoute
            ? t('hostScreen.deleteConfirm.removeTitle', 'Remove Workspace')
            : t('common.delete', 'Delete'),
          icon: Trash2,
          destructive: true,
          disabled: connState !== 'connected' || primaryCheckout,
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
            const token = requestHostListDelete(deleteTarget)
            router.dismissTo(
              `/h/${encodeURIComponent(hostId)}?${HOST_LIST_DELETE_PARAM}=${encodeURIComponent(token)}`
            )
          }
        }
      ]
    : []
  return (
    <PullDownMenu
      visible={showHeaderMoreActions}
      anchorRef={anchorRef}
      groups={[panels, view, tabs, workspace]}
      onClose={() => setShowHeaderMoreActions(false)}
    />
  )
}
