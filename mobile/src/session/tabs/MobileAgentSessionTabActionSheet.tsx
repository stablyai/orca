import { ActionSheetModal } from '../../components/sheets/ActionSheetModal'
import { MobileForkMarkedName } from '../fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../fork/mobile-fork-marked-name'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
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
  const dismiss = () => setAgentSessionActionTarget(null)
  const title = tab?.title || t('session.sheets.chat', 'Chat')
  // A fork's sheet names it with its mark, so its actions are not mistaken for the original's.
  const forked = tab?.forked === true
  const workerActions = useMobileAllowAutoCloseActions(
    controller.client,
    workerSubjectOf(tab ?? undefined)
  )
  return (
    <ActionSheetModal
      visible={tab != null}
      title={forked ? <MobileForkMarkedName name={title} /> : title}
      titleAccessibilityLabel={forked ? mobileForkAccessibleName(title) : undefined}
      actions={[
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
