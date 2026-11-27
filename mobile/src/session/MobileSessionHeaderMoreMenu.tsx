import type { RefObject } from 'react'
import type { HostInstance } from 'react-native'
import { ALargeSmall, Columns2, SquareChevronRight } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { getMobileNativeChatCliForkActions } from './native-chat/history/mobile-native-chat-cli-fork'
import {
  getMobileTerminalChatContinuationActions,
  resolveMobileTerminalChatContinuation
} from './native-chat/history/mobile-terminal-chat-continuation-actions'
import { continueMobileTerminalInChat } from './mobile-terminal-chat-continuation'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'

type Props = {
  controller: MobileSessionController
  anchorRef: RefObject<HostInstance | null>
}

export function MobileSessionHeaderMoreMenu({ controller, anchorRef }: Props) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const {
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    showAgentSessionHistoryAction,
    openAgentSessionHistory,
    canSplitTerminals,
    terminalSplitActive,
    setShowTerminalLayout,
    setTextSizeSheet,
    showNativeChat,
    activeSessionTab,
    connState,
    createTabBusy,
    handleOpenQuickCommands
  } = controller
  const workspaceOnPairedHost = useWorkspaceOnPairedHost()
  const tabActionsDisabled = createTabBusy || connState !== 'connected'
  // Files, Source control and Checks live in the tabs sidebar.
  const panels: ActionSheetAction[] = [
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
      onDismiss: () => setShowHeaderMoreActions(false),
      t
    }).map((action) => ({ ...action, disabled: tabActionsDisabled })),
    ...getMobileTerminalChatContinuationActions({
      continuation: resolveMobileTerminalChatContinuation({
        tab: activeSessionTab,
        hostCapabilities: controller.hostCapabilities
      }),
      onDismiss: () => setShowHeaderMoreActions(false),
      onContinue: (continuation) => void continueMobileTerminalInChat(controller, continuation),
      t
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
