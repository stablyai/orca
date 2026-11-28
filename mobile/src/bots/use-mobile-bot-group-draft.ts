import { useCallback, useEffect, useRef, type SetStateAction } from 'react'
import {
  clearMobileNativeChatDraftForSend,
  editMobileNativeChatDraft,
  readMobileNativeChatDraftEditGeneration,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { appendReturnedDraftText } from '../../../src/shared/native-chat/input/drafts/returned-draft-text'
import { loadMobileNativeChatDrafts } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence'

// A group's rooms keep their drafts as chat tabs (mobileNativeChatScopeKey's shape) of a workspace named
// for the group, which no worktree id takes; one row per group, so a page deleting one rewrites no other's.
export function mobileBotGroupDraftWorkspaceId(groupId: string): string {
  return `bot-groups:${groupId}`
}

/** A room's draft key, a chat tab's scope so it is saved like one: the group's id for its original
 *  room, a thread's id for that thread. */
export function mobileBotGroupDraftKey(hostId: string, groupId: string, roomId: string): string {
  return `${hostId}\0${mobileBotGroupDraftWorkspaceId(groupId)}\0${roomId}`
}

/** A group room's composer text and photos, kept and saved with chat's drafts, so they outlive the
 *  room's page. */
export function useMobileBotGroupDraft(hostId: string, groupId: string, roomId: string) {
  const key = mobileBotGroupDraftKey(hostId, groupId, roomId)
  useEffect(() => {
    void loadMobileNativeChatDrafts(hostId, mobileBotGroupDraftWorkspaceId(groupId))
  }, [hostId, groupId])
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
