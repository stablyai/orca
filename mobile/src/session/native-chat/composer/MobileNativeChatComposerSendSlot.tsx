import type { RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import { isStructuredAgentSessionHostCommand } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { agentSessionInteractionCommand } from '../../../../../src/shared/agent-session/options/agent-session-interaction-mode'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import type { SessionOptionDescriptor } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import { MobileNativeChatStopButton } from '../input/MobileNativeChatStopButton'
import { MobileNativeChatControlSwap } from '../input/mobile-native-chat-control-swap'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { mobileNativeChatComposerShowsStop } from './mobile-native-chat-composer-layout'
import type { MobileNativeChatStructuredComposer } from './mobile-native-chat-structured-composer'
import { readMobileNativeChatPickedSkills } from './mobile-native-chat-draft-store'
import {
  MobileNativeChatSendButton,
  MobileNativeChatSteerPreviewButton
} from './MobileNativeChatSendButton'
import type { MobileNativeChatSteerHead } from './use-mobile-native-chat-composer-tray'
import { useMobileNativeChatSteerChordPreview } from './use-mobile-native-chat-steer-chord-preview'
import { useMobileNativeChatDictationFailed } from './MobileNativeChatDictationLeading'

/** Send's slot outside a queued edit: Send, Stop where Send can't deliver, or what a held Cmd/Ctrl would do. */
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
  sendDisabled,
  attaching,
  stop,
  onSend
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
  sendDisabled: boolean
  /** An attachment or dictation still on its way. */
  attaching: boolean
  stop: { onStop?: () => void; held: boolean } | null
  onSend: (intent?: MobileNativeChatSendIntent, keepFocus?: boolean) => void
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
        structured.catalog.conversationCommands,
        structured.catalog.cleanBackgroundTerminals
      ),
    steerHead,
    pickerOpen,
    sendAlternate: () => onSend({ alternate: true }, true)
  })
  const showsStop = mobileNativeChatComposerShowsStop({
    canStop: stop !== null,
    sendBlocked: sendDisabled,
    canSend,
    editing: attaching,
    draft: value,
    attachmentCount
  })
  // A dictation kept for Retry takes Send's room; a running agent keeps its Stop.
  if (dictationFailed && !(showsStop && stop)) {
    return null
  }
  if (steerChord.preview && (steerChord.preview === 'steer-queued' || canSend)) {
    // As desktop, the preview takes Send's slot at once, with no ease.
    return (
      <MobileNativeChatSteerPreviewButton
        preview={steerChord.preview}
        onPress={steerChord.runPreview}
      />
    )
  }
  return (
    <MobileNativeChatControlSwap swapKey={showsStop && stop ? 'stop' : 'send'}>
      {showsStop && stop ? (
        // Only this phone's own request holds Stop: a repeat is how a stuck stop escalates.
        <MobileNativeChatStopButton onStop={stop.onStop} held={stop.held} />
      ) : (
        <MobileNativeChatSendButton canSend={canSend} sendFollowUp={followUp} onSend={onSend} />
      )}
    </MobileNativeChatControlSwap>
  )
}
