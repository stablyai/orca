import type { ReactNode, RefObject } from 'react'
import { View, type TextInputInstance } from 'react-native'
import { mobileNativeChatComposerStyles as styles } from '../field/mobile-native-chat-composer-styles'
import { isStructuredAgentSessionHostCommand } from '../../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { agentSessionInteractionCommand } from '../../../../../../src/shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { NativeChatSendFollowUp } from '../../../../../../src/shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { MobileNativeChatStopButton } from '../../input/MobileNativeChatStopButton'
import { MobileNativeChatControlSwap } from '../../input/mobile-native-chat-control-swap'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { mobileNativeChatComposerShowsStop } from '../field/mobile-native-chat-composer-layout'
import type { MobileNativeChatStructuredComposer } from '../commands/mobile-native-chat-structured-composer'
import { readMobileNativeChatPickedSkills } from '../drafts/mobile-native-chat-draft-store'
import {
  MobileNativeChatSendButton,
  MobileNativeChatSteerPreviewButton
} from './MobileNativeChatSendButton'
import type { MobileNativeChatSteerHead } from '../menus/use-mobile-native-chat-composer-tray'
import { useMobileNativeChatSteerChordPreview } from '../field/use-mobile-native-chat-steer-chord-preview'
import { useMobileNativeChatDictationFailed } from '../dictation/MobileNativeChatDictationLeading'

/** Send's slot outside a queued edit: the mic until there is something to send, then Send; Stop where
 *  Send can't deliver, with the mic beside it; or what a held Cmd/Ctrl would do. */
export function MobileNativeChatComposerSendSlot({
  fieldRef,
  value,
  draftScopeKey,
  attachmentCount,
  structured,
  agent,
  snapshot,
  followUp,
  steerHead,
  pickerOpen,
  canSend,
  sending,
  sendDisabled,
  attaching,
  stop,
  mic,
  micLive,
  onSend,
  onWidth
}: {
  fieldRef: RefObject<TextInputInstance | null>
  value: string
  draftScopeKey: string | null | undefined
  attachmentCount: number
  structured: MobileNativeChatStructuredComposer | null
  agent: string | null
  snapshot: readonly SessionOptionDescriptor[] | undefined
  followUp: NativeChatSendFollowUp | null
  steerHead: MobileNativeChatSteerHead | undefined
  pickerOpen: boolean
  canSend: boolean
  sending: boolean
  sendDisabled: boolean
  /** An attachment or dictation still on its way. */
  attaching: boolean
  stop: { onStop?: () => void; held: boolean } | null
  /** The composer's mic; null where the chat has no dictation. */
  mic: ReactNode
  /** Dictation is starting, recording or transcribing: the mic keeps the slot. */
  micLive: boolean
  onSend: (intent?: MobileNativeChatSendIntent, keepFocus?: boolean) => void
  /** The slot's width, which the idle pill's field stops short of. */
  onWidth: (width: number) => void
}): React.JSX.Element | null {
  const dictationFailed = useMobileNativeChatDictationFailed()
  const steerChord = useMobileNativeChatSteerChordPreview({
    fieldRef,
    hasDraft: value.trim() !== '' || attachmentCount > 0,
    followUp,
    // A typed chat command runs as itself, so the chord sends it no differently; a picked
    // interaction-mode skill (/plan) is a message, as the phone's send reads it.
    deliversMessage:
      !structured ||
      (agentSessionInteractionCommand(agent ?? '', value) !== null &&
        draftScopeKey != null &&
        readMobileNativeChatPickedSkills(draftScopeKey).some(
          (skill) => value.trimEnd() === `/${skill.name}`
        )) ||
      !isStructuredAgentSessionHostCommand(
        value,
        structured.threadGoal?.changes === 'host',
        agent ?? undefined,
        snapshot ?? [],
        structured.mcpPanel != null
      ),
    steerHead,
    pickerOpen,
    sendAlternate: () => onSend({ alternate: true }, true)
  })
  const showsStop = mobileNativeChatComposerShowsStop({
    canStop: stop !== null,
    sendBlocked: sendDisabled,
    canSend,
    sending,
    editing: attaching,
    draft: value,
    attachmentCount
  })
  const stopping = showsStop && stop !== null
  const hasDraft = value.trim() !== '' || attachmentCount > 0
  // The mic holds the slot until there is something to send; a live or failed dictation keeps it.
  const micHoldsSlot = micLive || dictationFailed || (!hasDraft && !sending)
  const preview = steerChord.preview && (steerChord.preview === 'steer-queued' || canSend)
  const control = stopping ? 'stop' : mic !== null && micHoldsSlot ? null : 'send'
  return (
    <View
      style={styles.trailingControls}
      onLayout={(event) => onWidth(event.nativeEvent.layout.width)}
    >
      {/* Always first, so a held mic is never remounted when Stop or a preview comes or goes mid-hold. */}
      {mic !== null && (stopping || micHoldsSlot) ? mic : null}
      {preview && steerChord.preview ? (
        // As desktop, the preview takes Send's slot at once, with no ease.
        <MobileNativeChatSteerPreviewButton
          preview={steerChord.preview}
          onPress={steerChord.runPreview}
        />
      ) : control ? (
        <MobileNativeChatControlSwap swapKey={control}>
          {stop && control === 'stop' ? (
            // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
            <MobileNativeChatStopButton onStop={stop.onStop} held={stop.held} />
          ) : (
            <MobileNativeChatSendButton
              canSend={canSend}
              sending={sending}
              sendFollowUp={followUp}
              onSend={onSend}
            />
          )}
        </MobileNativeChatControlSwap>
      ) : null}
    </View>
  )
}
