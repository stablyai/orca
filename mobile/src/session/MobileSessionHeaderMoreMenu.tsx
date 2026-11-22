import type { RefObject } from 'react'
import type { HostInstance } from 'react-native'
import {
  ALargeSmall,
  Columns2,
  Folder,
  GitBranch,
  History,
  LayoutList,
  ListChecks,
  Plus,
  SquareChevronRight
} from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import type { MobileSessionController } from './use-mobile-session-controller'
import { getMobileNativeChatCliForkActions } from './native-chat/history/mobile-native-chat-cli-fork'
import { useMobileSessionTabBarMode } from './tabs/use-mobile-session-tab-bar-mode'

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
    showRecentSessionCardsAction,
    setShowRecentSessionCards,
    visibleTabs,
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
  const { mode: tabBarMode, toggleMode: toggleTabBarMode } = useMobileSessionTabBarMode()
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
      : []),
    {
      id: 'tabBarMode',
      label:
        tabBarMode === 'classic-strip'
          ? t('session.header.switchToSingleTabBar', 'Switch to full-width tab bar')
          : t('session.header.switchToCompactTabStrip', 'Switch to compact tab strip'),
      icon: LayoutList,
      closeBeforePress: true,
      onPress: () => {
        toggleTabBarMode()
      }
    }
  ]
  const recentlyUsedVisible = showRecentSessionCardsAction && (visibleTabs?.length ?? 0) === 0
  const tabs: ActionSheetAction[] = [
    ...(recentlyUsedVisible
      ? [
          {
            id: 'recentlyUsed',
            label: t('recentSessionCardsSectionTitle', 'Recently Used'),
            icon: History,
            closeBeforePress: true,
            onPress: () => setShowRecentSessionCards(true)
          }
        ]
      : []),
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
      : []),
    ...getMobileNativeChatCliForkActions({
      controller,
      tab: activeSessionTab?.type === 'agent-session' ? activeSessionTab : null,
      workspaceOnPairedHost,
      onDismiss: () => setShowHeaderMoreActions(false)
    }).map((action) => ({ ...action, disabled: tabActionsDisabled }))
  ]
  return (
    <PullDownMenu
      visible={showHeaderMoreActions}
      anchorRef={anchorRef}
      groups={[panels, view, tabs]}
      onClose={() => setShowHeaderMoreActions(false)}
    />
  )
}
