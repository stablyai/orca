import { useMobileRegisteredAgent } from '../native-chat/agent-session/use-mobile-registered-agent'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { GitFork } from 'lucide-react-native'
import { forkMobileStructuredChat } from '../mobile-structured-chat-fork'
import { AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { ActionSheetModal } from '../../components/sheets/ActionSheetModal'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { mobileSessionTabMenuHeader } from './MobileSessionTabMark'
import { getMobileNativeChatCliForkActions } from '../native-chat/history/mobile-native-chat-cli-fork'
import { useMobileAllowAutoCloseActions, workerSubjectOf } from './mobile-worker-auto-close'
import type { MobileSessionController } from '../use-mobile-session-controller'

/** The long-pressed chat tab's actions: continue in a CLI, Allow Auto-Close on a kept worker, close. */
export function MobileAgentSessionTabActionSheet({
  controller,
  workspaceOnPairedHost
}: {
  controller: MobileSessionController
  workspaceOnPairedHost: boolean
}) {
  const t = useMobileTranslation()
  const {
    agentSessionActionTarget: tab,
    setAgentSessionActionTarget,
    closeWithBulkActions
  } = controller
  const currentFork = useMobileRegisteredAgent(
    controller.client,
    !!tab &&
      controller.hostCapabilities?.includes(
        AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY
      ) === true,
    tab?.agent ?? null
  )?.capabilities.currentFork
  const agent = tab && isTuiAgent(tab.agent) ? tab.agent : null
  const dismiss = () => setAgentSessionActionTarget(null)
  const title = tab?.title || t('session.sheets.chat', 'Chat')
  // A fork's sheet names it with its mark, so its actions are not mistaken for the original's.
  const forked = tab?.forked === true || tab?.sideChat === true
  const workerActions = useMobileAllowAutoCloseActions(
    controller.client,
    workerSubjectOf(tab ?? undefined)
  )
  return (
    <ActionSheetModal
      visible={tab != null}
      {...mobileSessionTabMenuHeader(tab, controller.terminals)}
      groupDestructive
      title={forked ? <MobileForkMarkedName name={title} sideChat={tab?.sideChat} /> : title}
      titleAccessibilityLabel={forked ? mobileForkAccessibleName(title) : undefined}
      actions={[
        ...(tab &&
        agent &&
        currentFork &&
        controller.hostCapabilities?.includes(AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY)
          ? [
              {
                id: 'currentSideChat',
                label: t('session.currentSideChat.open', 'New side chat'),
                icon: GitFork,
                onPress: () => {
                  dismiss()
                  void forkMobileStructuredChat(controller, agent, {
                    sessionId: tab.sessionId,
                    current: true,
                    permission: 'inherit'
                  })
                }
              }
            ]
          : []),

        ...getMobileNativeChatCliForkActions({
          controller,
          tab,
          workspaceOnPairedHost,
          onDismiss: dismiss
        }),
        ...workerActions,
        ...closeWithBulkActions(tab, dismiss)
      ]}
      onClose={dismiss}
    />
  )
}
