import { useEffect, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { isNewerApprovalSubject } from '../../../../../src/shared/agent-session-approval-subject'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import type { MobileChatPermission } from './mobile-native-chat-permission'

// As on desktop a shown card replaces the composer (kept mounted for its draft), except while dictation runs or lands
// in it, or for a card that cannot take the answer: a terminal-only ask, or an approval this build cannot draw.
export function useMobileNativeChatPromptInputOwner(
  {
    promptShown,
    ask,
    askRequiresTerminal,
    permission,
    micActive,
    micProcessing
  }: {
    promptShown: boolean
    ask?: AskPrompt | null
    askRequiresTerminal: boolean
    permission?: MobileChatPermission | null
    micActive?: boolean
    micProcessing?: boolean
  },
  composerInputRef: RefObject<TextInput | null> | undefined
): boolean {
  const owns =
    promptShown &&
    !micActive &&
    !micProcessing &&
    (ask != null ? !askRequiresTerminal : !isNewerApprovalSubject(permission?.subject))
  useEffect(() => {
    if (owns) {
      composerInputRef?.current?.blur()
    }
  }, [owns, composerInputRef])
  return owns
}
