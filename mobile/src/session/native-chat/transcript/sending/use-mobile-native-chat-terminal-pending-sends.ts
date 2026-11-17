import { useCallback, useMemo } from 'react'
import { nativeChatPendingSendPlacement } from '../../../../../../src/shared/native-chat/transcript/pending-sends/native-chat-pending-sends'
import type { useMobileNativeChatDrafts } from '../../composer/drafts/use-mobile-native-chat-drafts'

type Drafts = ReturnType<typeof useMobileNativeChatDrafts>

/** Places pending sends against the terminal turn's working epoch, and stamps new ones with it. */
export function useMobileNativeChatTerminalPendingSends(
  chatPending: Drafts['pending'],
  captureSendOrigin: Drafts['captureSendOrigin'],
  workingEpoch: number | null | undefined
) {
  const placedChatPending = useMemo(
    () =>
      chatPending.map((entry) => ({
        ...entry,
        pendingSend: nativeChatPendingSendPlacement(entry, workingEpoch)
      })),
    [chatPending, workingEpoch]
  )
  const captureTerminalSendOrigin = useCallback(
    (text: string, sentAt?: number) => {
      const origin = captureSendOrigin(text, sentAt)
      return origin ? { ...origin, queuedDuringWorkingEpoch: workingEpoch } : null
    },
    [captureSendOrigin, workingEpoch]
  )
  return { placedChatPending, captureTerminalSendOrigin }
}
