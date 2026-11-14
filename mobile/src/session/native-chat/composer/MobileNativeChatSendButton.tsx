import { useState } from 'react'
import { Pressable } from 'react-native'
import { CornerDownRight, ListEnd } from 'lucide-react-native'
import type {
  NativeChatFollowUpBehavior,
  NativeChatSendFollowUp
} from '../../../../../src/shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { NativeChatSteerChordPreview } from '../../../../../src/shared/native-chat/input/composer/use-native-chat-steer-chord-preview'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { ComposerSendButton } from '../../../components/composer-input/ComposerSendButton'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'

const FOLLOW_UP_ICON = { queue: ListEnd, steer: CornerDownRight } as const

/** Send, the same arrow as desktop at all times; while the agent works on a host that queues, holding it offers the other way when that would differ (desktop's Cmd/Ctrl+Enter). */
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
        label={t('chat.composer.sendMessage', 'Send message')}
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

/** Send while Cmd/Ctrl is held alone: what Cmd/Ctrl+Enter would do, as desktop shows it. */
export function MobileNativeChatSteerPreviewButton({
  preview,
  onPress
}: {
  preview: NativeChatSteerChordPreview
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // A press must leave focus in the field, or its focusout ends the preview before the press lands.
  const keepsField = useKeyboardPersistingTaps('always')
  const label =
    preview === 'queue'
      ? t('chat.composer.sendQueue', 'Queue')
      : preview === 'steer'
        ? t('chat.composer.sendSteer', 'Steer')
        : t('chat.composer.sendSteerQueued', 'Steer queued')
  const Icon = preview === 'queue' ? ListEnd : CornerDownRight
  return (
    <Pressable
      ref={keepsField}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [inputStyles.sendButton, pressed && inputStyles.pressed]}
      onPress={(event) => {
        // As desktop: the action can change between a double-click's presses (Steer, then Steer queued).
        const native = event.nativeEvent
        const detail = 'detail' in native ? native.detail : undefined
        if (typeof detail !== 'number' || detail <= 1) {
          onPress()
        }
      }}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
    >
      <Icon size={19} color={colors.bgBase} strokeWidth={2.4} />
    </Pressable>
  )
}
