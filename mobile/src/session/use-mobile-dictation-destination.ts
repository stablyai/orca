import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  insertDictationText,
  type MobileDictationAnchor
} from '../dictation/mobile-dictation-text-insertion'
import {
  captureMobileNativeChatTextDestination,
  type MobileNativeChatDictationPreview,
  type MobileNativeChatTextDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { editMobileNativeChatDraft } from './native-chat/composer/mobile-native-chat-draft-store'

type MobileDictationTarget =
  | { field: 'chat'; scope: string | null; anchor: MobileDictationAnchor | null }
  | { field: 'command'; handle: string | null; anchor: MobileDictationAnchor | null }
  // Live terminal input: the words show on that terminal's status row.
  | { field: 'live'; handle: string }
  | null

// The terminal a dictation starts in. Terminals share one command field: a selection read in another terminal doesn't place this one's words.
export function dictationRouteContextFor(
  handle: string | null,
  liveInputHandles: ReadonlySet<string>,
  saved: { handle: string | null; anchor: MobileDictationAnchor } | null
) {
  return handle
    ? {
        handle,
        liveInputEnabled: liveInputHandles.has(handle),
        anchor: saved?.handle === handle ? saved.anchor : null
      }
    : null
}

// Where a dictation's words go, read once when it starts: a chat composer, the terminal's command field, or live input.
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
    (
      chatShown: boolean,
      terminal: {
        handle: string
        liveInputEnabled: boolean
        anchor: MobileDictationAnchor | null
      } | null
    ) => {
      const chat = captureMobileNativeChatTextDestination()
      chatRef.current = chat
      targetRef.current =
        chat || chatShown
          ? {
              field: 'chat',
              scope: chat ? chat.scope : (chatComposerScopeKey ?? null),
              anchor: chat?.anchor ?? null
            }
          : terminal?.liveInputEnabled
            ? { field: 'live', handle: terminal.handle }
            : {
                field: 'command',
                handle: terminal?.handle ?? null,
                anchor: terminal?.anchor ?? null
              }
      setTarget(targetRef.current)
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
    // A chat dictation stays in its chat after a switch; a terminal's draft can't take words once a chat replaces it.
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
  // Another terminal's draft takes the words at its end, so the saved selection only places them in its own.
  const commandDictationPreview = useMemo(
    () =>
      heard && target?.field === 'command'
        ? { anchor: target.handle === activeHandle ? target.anchor : null, text: heard }
        : null,
    [activeHandle, heard, target]
  )
  return {
    chatDictationPreview,
    commandDictationPreview,
    liveDictationText: target?.field === 'live' && target.handle === activeHandle ? heard : ''
  }
}
