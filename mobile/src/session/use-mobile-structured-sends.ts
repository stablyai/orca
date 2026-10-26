// Project each local send until the host records its id; lost replies stay hidden unless their deadline expires first.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { MobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'
import {
  UNCONFIRMED_SEND_DEADLINE_MS,
  UNCONFIRMED_SEND_MESSAGE
} from './native-chat/use-mobile-native-chat-unconfirmed-sends'

type MobileStructuredSend = StructuredAgentSessionOptimisticMessage & { unconfirmed?: true }

const NO_SENDS: readonly MobileStructuredSend[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export type MobileStructuredSends = {
  optimistic: readonly StructuredAgentSessionOptimisticMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  accept: (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => void
  hold: (send: StructuredAgentSessionOptimisticMessage) => void
}

export function useMobileStructuredSends(args: {
  sessionKey: string
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessages: MobileQueuedMessageFeed
  onSendError: MobileNativeChatSendErrorReporter
}): MobileStructuredSends {
  const { cursor, onSendError, queuedMessages, sessionKey, submissions } = args
  const [sendsBySession, setSendsBySession] = useState<
    Record<string, readonly MobileStructuredSend[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const deadlinesRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const mountedRef = useRef(false)

  // Capture chat ownership before asynchronous replies can cross a tab switch.
  const keep = useCallback(
    (send: MobileStructuredSend) =>
      setSendsBySession((previous) => ({
        ...previous,
        [sessionKey]: [...(previous[sessionKey] ?? []), send]
      })),
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
  const hold = useCallback(
    (send: StructuredAgentSessionOptimisticMessage) => {
      if (!mountedRef.current) {
        return
      }
      const id = send.clientMessageId
      deadlinesRef.current.set(
        id,
        setTimeout(() => {
          deadlinesRef.current.delete(id)
          forget(new Set([id]))
          onSendError(UNCONFIRMED_SEND_MESSAGE)
        }, UNCONFIRMED_SEND_DEADLINE_MS)
      )
      keep({ ...send, unconfirmed: true })
    },
    [forget, keep, onSendError]
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
    for (const id of settled) {
      clearTimeout(deadlinesRef.current.get(id))
      deadlinesRef.current.delete(id)
    }
    forget(settled)
  }, [cursor, forget, queuedMessages, sends, submissions])

  useEffect(() => {
    mountedRef.current = true
    const deadlines = deadlinesRef.current
    return () => {
      mountedRef.current = false
      for (const deadline of deadlines.values()) {
        clearTimeout(deadline)
      }
      deadlines.clear()
    }
  }, [])

  const optimistic = useMemo(() => sends.filter((send) => !send.unconfirmed), [sends])
  return {
    optimistic,
    imagePreviewsByMessageId: imagePreviewsBySession[sessionKey] ?? NO_IMAGE_PREVIEWS,
    accept,
    hold
  }
}
