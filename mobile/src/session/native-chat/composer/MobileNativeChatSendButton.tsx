import { useState } from 'react'
import { CornerDownRight, ListEnd } from 'lucide-react-native'
import type {
  NativeChatFollowUpBehavior,
  NativeChatSendFollowUp
} from '../../../../../src/shared/native-chat-follow-up-behavior'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { ComposerSendButton } from '../../../components/composer-input/ComposerSendButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'

const FOLLOW_UP_ICON = { queue: ListEnd, steer: CornerDownRight } as const

/** Send; while the agent works on a host that queues, it shows what a tap does, and holding it offers the other way when that would differ. */
export function MobileNativeChatSendButton({
  canSend,
  sendFollowUp,
  onSend
}: {
  canSend: boolean
  sendFollowUp: NativeChatSendFollowUp | null
  onSend: (intent?: MobileNativeChatSendIntent) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const label = {
    queue: t('chat.composer.sendQueue', 'Queue'),
    steer: t('chat.composer.sendSteer', 'Steer')
  }
  const hint = {
    queue: t('chat.composer.sendQueueHint', 'Runs after the current turn'),
    steer: t('chat.composer.sendSteerHint', 'Goes into what the agent is doing now')
  }
  const action = sendFollowUp?.action
  const choices: NativeChatFollowUpBehavior[] =
    action === 'queue' ? ['queue', 'steer'] : ['steer', 'queue']
  return (
    <>
      <ComposerSendButton
        onPress={() => onSend()}
        onLongPress={sendFollowUp?.offersChoice && canSend ? () => setOpen(true) : undefined}
        canSend={canSend}
        label={action ? label[action] : t('chat.composer.sendMessage', 'Send message')}
        icon={action ? FOLLOW_UP_ICON[action] : undefined}
      />
      <ActionSheetModal
        visible={open}
        onClose={() => setOpen(false)}
        actions={choices.map((choice) => ({
          id: choice,
          label: label[choice],
          hint: hint[choice],
          icon: FOLLOW_UP_ICON[choice],
          checked: choice === action,
          // Only the choice other than a tap's is the alternate; the send resolves it against the state then.
          onPress: () => (choice === action ? onSend() : onSend({ alternate: true }))
        }))}
      />
    </>
  )
}
