import { useState } from 'react'
import { CornerDownRight, ListEnd } from 'lucide-react-native'
import type { NativeChatFollowUpBehavior } from '../../../../../src/shared/native-chat-follow-up-behavior'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { ComposerSendButton } from '../../../components/composer-input/ComposerSendButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'

/** Send; while the agent works on a host that queues, holding it offers Queue or Steer for this message. */
export function MobileNativeChatSendButton({
  canSend,
  sendMenu,
  onSend
}: {
  canSend: boolean
  /** The host's follow-up setting while the hold menu is offered; null otherwise. */
  sendMenu: NativeChatFollowUpBehavior | null
  onSend: (intent?: MobileNativeChatSendIntent) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  // Read at the choice: only a choice other than the setting is the alternate.
  const choose = (choice: NativeChatFollowUpBehavior): void =>
    sendMenu !== null && choice !== sendMenu ? onSend({ alternate: true }) : onSend()
  return (
    <>
      <ComposerSendButton
        onPress={() => onSend()}
        onLongPress={sendMenu !== null && canSend ? () => setOpen(true) : undefined}
        canSend={canSend}
        label={t('chat.composer.sendMessage', 'Send message')}
      />
      <ActionSheetModal
        visible={open}
        onClose={() => setOpen(false)}
        actions={[
          {
            id: 'queue',
            label: t('chat.composer.sendQueue', 'Queue'),
            icon: ListEnd,
            onPress: () => choose('queue')
          },
          {
            id: 'steer',
            label: t('chat.composer.sendSteer', 'Steer'),
            icon: CornerDownRight,
            onPress: () => choose('steer')
          }
        ]}
      />
    </>
  )
}
