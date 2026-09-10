import { useCallback, useReducer, useRef, type SetStateAction } from 'react'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'
import {
  createMobileNativeChatDraftOwnership,
  reduceMobileNativeChatDraftOwnership
} from './mobile-native-chat-draft-ownership'

export function useMobileNativeChatDraftOwnership(draftKey: string | null) {
  const [state, dispatch] = useReducer(
    reduceMobileNativeChatDraftOwnership,
    undefined,
    createMobileNativeChatDraftOwnership
  )
  const composerGeneration = useRef(0)
  const getComposerEditGeneration = useCallback(() => composerGeneration.current, [])
  const setComposerText = useCallback(
    (value: SetStateAction<string>) => {
      if (!draftKey) {
        return
      }
      composerGeneration.current += 1
      dispatch({ type: 'edit', draftKey, value })
    },
    [draftKey]
  )
  const setDrafts = useCallback((value: SetStateAction<Record<string, string>>) => {
    dispatch({ type: 'seed', value })
  }, [])
  const ownSendOrigin = useCallback((origin: MobileNativeChatSendOrigin) => {
    dispatch({ type: 'capture', origin })
    return origin
  }, [])
  const releaseSendOrigin = useCallback((origin: MobileNativeChatSendOrigin) => {
    // Retirement shares React's queue with mutations, including deferred/replayed restores.
    dispatch({ type: 'release', origin })
  }, [])
  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    dispatch({ type: 'clear', origin, text })
  }, [])
  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    dispatch({ type: 'restore', origin, text })
  }, [])
  return {
    drafts: state.drafts,
    setDrafts,
    setComposerText,
    getComposerEditGeneration,
    ownSendOrigin,
    releaseSendOrigin,
    clearDraftForSend,
    restoreRejectedDraft
  }
}
