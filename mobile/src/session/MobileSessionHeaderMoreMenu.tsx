import type { RefObject } from 'react'
import type { View } from 'react-native'
import {
  Columns2,
  Folder,
  GitBranch,
  ListChecks,
  Plus,
  SquareChevronRight
} from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'

type Props = {
  controller: MobileSessionController
  anchorRef: RefObject<View | null>
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
    connState,
    createTabBusy,
    handleOpenNewTab,
    handleOpenQuickCommands
  } = controller
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
    ...(actionsCollapsed && !isFolderWorkspaceRoute && !isFloatingWorkspaceRoute
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
    {
      id: 'quickCommands',
      label: t('session.header.quickCommands', 'Quick commands'),
      icon: SquareChevronRight,
      disabled: tabActionsDisabled,
      closeBeforePress: true,
      onPress: handleOpenQuickCommands
    }
  ]
  const view: ActionSheetAction[] =
    canSplitTerminals || terminalSplitActive
      ? [
          {
            id: 'terminalLayout',
            label: t('session.header.terminalLayout', 'Terminal layout'),
            icon: Columns2,
            closeBeforePress: true,
            onPress: () => setShowTerminalLayout(true)
          }
        ]
      : []
  const tabs: ActionSheetAction[] = actionsCollapsed
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
    : []
  return (
    <PullDownMenu
      visible={showHeaderMoreActions}
      anchorRef={anchorRef}
      groups={[panels, view, tabs]}
      onClose={() => setShowHeaderMoreActions(false)}
    />
  )
}
