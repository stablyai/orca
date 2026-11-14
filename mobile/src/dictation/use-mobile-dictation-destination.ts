import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { insertDictationText, type MobileDictationAnchor } from './mobile-dictation-text-insertion'
import {
  captureMobileNativeChatTextDestination,
  type MobileNativeChatDictationPreview,
  type MobileNativeChatTextDestination
} from '../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import { editMobileNativeChatDraft } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'

type MobileDictationTarget =
  | { field: 'chat'; scope: string | null; anchor: MobileDictationAnchor | null }
  // Live terminal input: the words show on that terminal's status row.
  | { field: 'live'; handle: string }
  | null

// Where a dictation's words go, read once when it starts: a chat composer or the terminal's live input.
export function useMobileDictationDestination({
  chatComposerScopeKey,
  setChatComposerText
}: {
  chatComposerScopeKey?: string | null
  setChatComposerText: Dispatch<SetStateAction<string>>
}) {
  const chatRef = useRef<MobileNativeChatTextDestination | undefined>(undefined)
  const [target, setTarget] = useState<MobileDictationTarget>(null)
  const targetRef = useRef<MobileDictationTarget>(null)
  const captureDestination = useCallback(
    (chatShown: boolean, terminalHandle: string | null) => {
      const chat = captureMobileNativeChatTextDestination()
      chatRef.current = chat
      targetRef.current =
        chat || chatShown
          ? {
              field: 'chat',
              scope: chat ? chat.scope : (chatComposerScopeKey ?? null),
              anchor: chat?.anchor ?? null
            }
          : terminalHandle
            ? { field: 'live', handle: terminalHandle }
            : null
      setTarget(targetRef.current)
      return targetRef.current
    },
    [chatComposerScopeKey]
  )
  // The final text goes to the chat captured at start, or the end of that chat's draft; false when that chat refused it.
  const insertInChat = useCallback(
    (text: string): boolean => {
      const chat = chatRef.current
      chatRef.current = undefined
      if (chat) {
        return chat.insert(text) !== false
      }
      const append = (current: string) => insertDictationText(current, text, null).text
      const captured = targetRef.current?.field === 'chat' ? targetRef.current.scope : null
      if (captured && captured !== chatComposerScopeKey) {
        editMobileNativeChatDraft(captured, append)
      } else {
        setChatComposerText(append)
      }
      return true
    },
    [chatComposerScopeKey, setChatComposerText]
  )
  return {
    target,
    captureDestination,
    // A chat dictation stays in its chat after a switch; a terminal can't take words once a chat replaces it.
    landsInChat: (chatShown: boolean) => chatShown || targetRef.current?.field === 'chat',
    insertInChat
  }
}

// The words heard so far, drawn where the dictation's target will put them.
export function useMobileDictationPreviews(
  { target }: { target: MobileDictationTarget },
  { transcriptSoFar: heard }: { transcriptSoFar: string },
  activeHandle: string | null
) {
  // Memoized: the chat preview is a context value every composer reads.
  const chatDictationPreview = useMemo<MobileNativeChatDictationPreview | null>(
    () =>
      heard && target?.field === 'chat'
        ? { scope: target.scope, anchor: target.anchor, text: heard }
        : null,
    [heard, target]
  )
  return {
    chatDictationPreview,
    liveDictationText: target?.field === 'live' && target.handle === activeHandle ? heard : ''
  }
}
