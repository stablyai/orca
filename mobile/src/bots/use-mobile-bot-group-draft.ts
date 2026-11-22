import { useCallback, useRef, type SetStateAction } from 'react'
import {
  clearMobileNativeChatDraftForSend,
  editMobileNativeChatDraft,
  readMobileNativeChatDraftEditGeneration,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { appendReturnedDraftText } from '../../../src/shared/native-chat/input/drafts/returned-draft-text'

/** A room's draft key: the group's id for its original room, a thread's id for that thread. */
export function mobileBotGroupDraftKey(hostId: string, roomId: string): string {
  return `group:${hostId}:${roomId}`
}

/** A group room's composer text, kept in native chat's draft store so it outlives leaving the room. */
export function useMobileBotGroupDraft(hostId: string, roomId: string) {
  const key = mobileBotGroupDraftKey(hostId, roomId)
  const text = useMobileNativeChatDraft(key)
  const editGenerationRef = useRef(0)
  const edit = useCallback(
    (value: SetStateAction<string>) => {
      editGenerationRef.current += 1
      editMobileNativeChatDraft(key, value)
    },
    [key]
  )
  return {
    key,
    text,
    edit,
    getEditGeneration: () => editGenerationRef.current,
    // Cleared at send like native chat: an edit made meanwhile survives, and a refused post comes back.
    clearForSend: (sent: string) =>
      clearMobileNativeChatDraftForSend(key, readMobileNativeChatDraftEditGeneration(key), sent),
    restoreRefused: (sent: string) =>
      setMobileNativeChatDraftText(key, (current) => appendReturnedDraftText(current, sent))
  }
}
