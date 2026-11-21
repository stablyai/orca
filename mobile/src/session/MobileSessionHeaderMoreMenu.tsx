import type { ReactNode } from 'react'
import {
  ALargeSmall,
  Columns2,
  Folder,
  GitBranch,
  ListChecks,
  Plus,
  SquareChevronRight
} from '../components/icons/app-icons'
import { AgentSessionHistoryMenuIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { NativeMenu } from '../components/menu/NativeMenu'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { getMobileNativeChatCliForkActions } from './native-chat/history/mobile-native-chat-cli-fork'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'

type Props = {
  controller: MobileSessionController
  /** A narrow sideways header also moves source control and New tab in here. */
  actionsCollapsed: boolean
  /** The ⋯ button; call `openMenu` from its press. */
  children: (openMenu: () => void) => ReactNode
}

export function MobileSessionHeaderMoreMenu({ controller, actionsCollapsed, children }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
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
    itemsOnPhone
  } = controller
  const workspaceOnPairedHost = useWorkspaceOnPairedHost()
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
            icon: AgentSessionHistoryMenuIcon,
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
  return (
    <NativeMenu
      groups={[panels, view, tabs]}
      onOpenChange={setShowHeaderMoreActions}
    >
      {children}
    </NativeMenu>
  )
}
