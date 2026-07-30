import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  NO_PENDING_MESSAGES,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'
import { reconcilePendingMessages } from './mobile-native-chat-draft-reconcile'

export function useMobileNativeChatPendingMessages(
  pendingKey: string | null,
  messages: readonly NativeChatMessage[]
): {
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  pending: MobileNativeChatPendingMessage[]
} {
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const counterRef = useRef(0)
  const pending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      if (!origin.pendingKey) {
        return
      }
      const originPendingKey = origin.pendingKey
      counterRef.current += 1
      setPendingBySession((previous) => {
        const current = previous[originPendingKey] ?? NO_PENDING_MESSAGES
        const earlierOutstanding = current.filter(
          (entry) =>
            entry.text.trim() === origin.normalizedText &&
            entry.expectedOccurrence > origin.baselineOccurrences
        ).length
        const expectedImageEchoOrdinal =
          current.reduce(
            (sum, entry) =>
              sum + (entry.images?.length ?? (entry.text.trim() === '' ? 1 : 0)),
            0
          ) + Math.max(1, images?.length ?? 0)
        const entry: MobileNativeChatPendingMessage = {
          id: `pending-${counterRef.current}`,
          text,
          expectedOccurrence:
            origin.normalizedText === ''
              ? expectedImageEchoOrdinal
              : origin.baselineOccurrences + earlierOutstanding + 1,
          baselineTailMessageId: origin.baselineTailMessageId,
          ...(images?.length ? { images } : {})
        }
        return { ...previous, [originPendingKey]: [...current, entry] }
      })
    },
    []
  )

  useEffect(() => {
    if (!pendingKey || pending.length === 0) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const next = reconcilePendingMessages(messages, current)
      if (next === current) {
        return previous
      }
      if (next.length > 0) {
        return { ...previous, [pendingKey]: next }
      }
      const remaining = { ...previous }
      delete remaining[pendingKey]
      return remaining
    })
  }, [messages, pending, pendingKey])

  return { acceptSend, pending }
}
