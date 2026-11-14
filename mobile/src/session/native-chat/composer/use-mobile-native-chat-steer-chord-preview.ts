import type { RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { NativeChatSteerChordPreview } from '../../../../../src/shared/native-chat/input/composer/use-native-chat-steer-chord-preview'
import type { MobileNativeChatSteerHead } from './use-mobile-native-chat-composer-tray'

export type MobileNativeChatSteerChordPreviewInput = {
  fieldRef: RefObject<TextInputInstance | null>
  hasDraft: boolean
  followUp: NativeChatSendFollowUp | null
  /** False for a typed chat command, which runs as itself rather than queue or steer. */
  deliversMessage: boolean
  /** Absent where the empty chord sends no queued card (a host goal). */
  steerHead: MobileNativeChatSteerHead | undefined
  /** An open menu takes Enter. */
  pickerOpen: boolean
  sendAlternate: () => void
}

const NO_PREVIEW: { preview: NativeChatSteerChordPreview | null; runPreview: () => void } = {
  preview: null,
  runPreview: () => undefined
}

// Only the web field submits on Cmd/Ctrl+Enter, so a native build has no chord to preview.
export function useMobileNativeChatSteerChordPreview(
  _input: MobileNativeChatSteerChordPreviewInput
) {
  return NO_PREVIEW
}
