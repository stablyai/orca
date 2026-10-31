// Ordinary in-memory input outlives its request; exact host IDs retire it.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { StructuredAgentSessionOptimisticMessage } from '../../../src/shared/structured-agent-session-message-projection'
import {
  structuredAgentSessionReadCoversSend,
  structuredAgentSessionSettledSends
} from '../../../src/shared/structured-agent-session-send-settlement'
import { mergeSentImagePreviews } from './native-chat/composer/mobile-native-chat-draft-reconcile'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'

type MobileStructuredSend = StructuredAgentSessionOptimisticMessage

const NO_SENDS: readonly MobileStructuredSend[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export type MobileStructuredSends = {
  optimistic: readonly StructuredAgentSessionOptimisticMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  accept: (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => void
  reject: (clientMessageId: string) => void
}

export function useMobileStructuredSends(args: {
  sessionKey: string
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  onSendError: MobileNativeChatSendErrorReporter
}): MobileStructuredSends {
  const { cursor, queuedMessages, sessionKey, submissions } = args
  const [sendsBySession, setSendsBySession] = useState<
    Record<string, readonly MobileStructuredSend[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const mountedRef = useRef(false)

  // Capture chat ownership before asynchronous replies can cross a tab switch.
  const keep = useCallback(
    (send: MobileStructuredSend) => {
      if (mountedRef.current) {
        setSendsBySession((previous) => ({
          ...previous,
          [sessionKey]: (previous[sessionKey] ?? []).some(
            (entry) => entry.clientMessageId === send.clientMessageId
          )
            ? previous[sessionKey].map((entry) =>
                entry.clientMessageId === send.clientMessageId ? send : entry
              )
            : [...(previous[sessionKey] ?? []), send]
        }))
      }
    },
    [sessionKey]
  )
  const forget = useCallback(
    (ids: ReadonlySet<string>) =>
      setSendsBySession((previous) => {
        const kept = (previous[sessionKey] ?? []).filter((send) => !ids.has(send.clientMessageId))
        const next = { ...previous, [sessionKey]: kept }
        if (kept.length === 0) {
          delete next[sessionKey]
        }
        return next
      }),
    [sessionKey]
  )
  const accept = useCallback(
    (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => {
      keep(send)
      if (images?.length) {
        // Use the host’s row id so attached photos survive acceptance or failure.
        const messageId = agentJournalSubmissionKey(send.clientMessageId)
        setImagePreviewsBySession((previous) =>
          mergeSentImagePreviews(previous, sessionKey, [{ messageId, images }])
        )
      }
    },
    [keep, sessionKey]
  )
  const reject = useCallback(
    (clientMessageId: string) => forget(new Set([clientMessageId])),
    [forget]
  )

  const sends = sendsBySession[sessionKey] ?? NO_SENDS
  useEffect(() => {
    if (sends.length === 0) {
      return
    }
    const { cards, recorded } = structuredAgentSessionSettledSends(
      submissions,
      (queuedMessages ?? []).map((message) => message.messageId)
    )
    const settled = new Set(
      sends
        .filter(
          (send) =>
            cards.has(send.clientMessageId) ||
            recorded.has(send.clientMessageId) ||
            structuredAgentSessionReadCoversSend(cursor, send.recordedCursor)
        )
        .map((send) => send.clientMessageId)
    )
    if (settled.size === 0) {
      return
    }
    forget(settled)
  }, [cursor, forget, queuedMessages, sends, submissions])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  return {
    optimistic: sends,
    imagePreviewsByMessageId: imagePreviewsBySession[sessionKey] ?? NO_IMAGE_PREVIEWS,
    accept,
    reject
  }
}
