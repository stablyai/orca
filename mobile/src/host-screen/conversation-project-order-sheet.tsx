import { ActionSheetModal } from '../components/ActionSheetModal'
import { projectOrderChoices } from './workspace-option-controls-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { HostScreenController } from './use-host-screen-controller'
import { conversationCopy } from './conversation-copy'

export function ConversationProjectOrderSheet({
  visible,
  onClose,
  controller
}: {
  visible: boolean
  onClose: () => void
  controller: HostScreenController
}) {
  const t = useMobileTranslation()
  const copy = conversationCopy()
  const connected = controller.connState === 'connected'
  return (
    <ActionSheetModal
      visible={visible}
      title={copy.projectOrder}
      onClose={() => onClose()}
      actions={projectOrderChoices(t).map((choice) => ({
        label: `${controller.projectOrderBy === choice.id ? '✓ ' : ''}${choice.label}`,
        onPress: () => {
          void controller.settings.setProjectOrderBy(choice.id)
        },
        disabled: !connected
      }))}
    />
  )
}
