// Lost acknowledgements may hide delivered sends: hold them quietly until transcript confirmation or deadline, without restoring drafts. Structured sends own a separate hold.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../../src/shared/native-chat-types'
import {
  findLandedUnconfirmedSends,
  type UnconfirmedSend
} from './composer/mobile-native-chat-draft-reconcile'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

export const UNCONFIRMED_SEND_DEADLINE_MS = 20_000
export const UNCONFIRMED_SEND_MESSAGE = 'Delivery unconfirmed — check chat before retrying'

export function useMobileNativeChatUnconfirmedSends(args: {
  draftKey: string | null
  pendingKey: string | null
  messages: readonly NativeChatMessage[]
}): {
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
} {
  const { draftKey, pendingKey, messages } = args
  const messagesRef = useRef(messages)
  const activeDraftKeyRef = useRef(draftKey)
  const activePendingKeyRef = useRef(pendingKey)
  // Read only by the post-send hold, which runs after the commit that set them.
  useLayoutEffect(() => {
    messagesRef.current = messages
    activeDraftKeyRef.current = draftKey
    activePendingKeyRef.current = pendingKey
  }, [draftKey, messages, pendingKey])
  const mountedRef = useRef(false)
  const unconfirmedRef = useRef<UnconfirmedSend[]>([])
  const holdUnconfirmedSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        return
      }
      const isActiveTranscript =
        activeDraftKeyRef.current === origin.draftKey &&
        (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
      const entry: UnconfirmedSend = {
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        deadline: null
      }
      // The confirming transcript event can arrive before the lost-ack RPC settles.
      if (
        isActiveTranscript &&
        findLandedUnconfirmedSends(messagesRef.current, [entry]).length > 0
      ) {
        return
      }
      entry.deadline = setTimeout(() => {
        unconfirmedRef.current = unconfirmedRef.current.filter((held) => held !== entry)
        onUnconfirmed()
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    []
  )

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevant = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey &&
        (entry.pendingKey === null || entry.pendingKey === pendingKey)
    )
    const landed = findLandedUnconfirmedSends(messages, relevant)
    if (landed.length === 0) {
      return
    }
    const landedSet = new Set(landed)
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !landedSet.has(entry))
    for (const entry of landed) {
      clearTimeout(entry.deadline ?? undefined)
    }
  }, [messages, draftKey, pendingKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        clearTimeout(entry.deadline ?? undefined)
      }
      unconfirmedRef.current = []
    }
  }, [])

  return { holdUnconfirmedSend }
}
