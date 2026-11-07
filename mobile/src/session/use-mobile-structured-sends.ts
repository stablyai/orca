import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalCursor } from '../../../src/shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionOptimisticMessage } from '../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import {
  structuredAgentSessionReadCoversSend,
  structuredAgentSessionSettledSends
} from '../../../src/shared/agent-session/requests/structured-agent-session-send-settlement'
import { mergeSentImagePreviews } from './native-chat/composer/mobile-native-chat-draft-reconcile'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'
import {
  UNCONFIRMED_SEND_DEADLINE_MS,
  UNCONFIRMED_SEND_MESSAGE,
  UNCONFIRMED_SEND_RESTORED_MESSAGE
} from './native-chat/use-mobile-native-chat-unconfirmed-sends'
import { returnMobileNativeChatInFlightSend } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  claimMobileNativeChatInFlightSends,
  mobileNativeChatInFlightSendIds,
  releaseMobileNativeChatInFlightSends,
  settleMobileNativeChatInFlightSend,
  useMobileNativeChatSavedInFlightVersion
} from './native-chat/composer/mobile-native-chat-in-flight-sends'
// Ordinary in-memory input outlives its request; exact host IDs retire it, and a lost reply hands it back at the deadline.

type MobileStructuredSend = StructuredAgentSessionOptimisticMessage

const NO_SENDS: readonly MobileStructuredSend[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export type MobileStructuredSends = {
  optimistic: readonly StructuredAgentSessionOptimisticMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  accept: (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => void
  acknowledge: (clientMessageId: string, cursor?: AgentJournalCursor) => void
  reject: (clientMessageId: string) => void
  holdUnconfirmed: (clientMessageId: string, onUnconfirmed: () => void) => void
}

// A held send's deadline runs only while connected: the journal cannot record anything while the host is out.
type Hold = { timer: ReturnType<typeof setTimeout> | null; fire: () => void }

export function useMobileStructuredSends(args: {
  sessionKey: string
  sessionId?: string | null
  connected?: boolean
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  onSendError: MobileNativeChatSendErrorReporter
}): MobileStructuredSends {
  const {
    connected = true,
    cursor,
    onSendError,
    queuedMessages,
    sessionId = null,
    sessionKey,
    submissions
  } = args
  const [sendsBySession, setSendsBySession] = useState<
    Record<string, readonly MobileStructuredSend[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const mountedRef = useRef(false)
  const sendsBySessionRef = useRef(sendsBySession)
  useLayoutEffect(() => {
    sendsBySessionRef.current = sendsBySession
  }, [sendsBySession])
  const holdsRef = useRef(new Map<string, Hold>())
  const connectedRef = useRef(connected)
  useLayoutEffect(() => {
    connectedRef.current = connected
  }, [connected])
  const savedInFlightVersion = useMobileNativeChatSavedInFlightVersion()

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
  const acknowledge = useCallback(
    (clientMessageId: string, recordedCursor?: AgentJournalCursor) => {
      if (mountedRef.current) {
        setSendsBySession((previous) => {
          const sends = previous[sessionKey]
          if (!sends?.some((send) => send.clientMessageId === clientMessageId)) {
            return previous
          }
          return {
            ...previous,
            [sessionKey]: sends.map((send) =>
              send.clientMessageId === clientMessageId
                ? { ...send, phase: 'recorded', ...(recordedCursor ? { recordedCursor } : {}) }
                : send
            )
          }
        })
      }
    },
    [sessionKey]
  )
  const reject = useCallback(
    (clientMessageId: string) => forget(new Set([clientMessageId])),
    [forget]
  )
  const isHeld = useCallback(
    (clientMessageId: string) =>
      (sendsBySessionRef.current[sessionKey] ?? []).some(
        (send) => send.clientMessageId === clientMessageId
      ),
    [sessionKey]
  )
  const hold = useCallback((clientMessageId: string, fire: () => void) => {
    const entry: Hold = { timer: null, fire }
    if (connectedRef.current) {
      entry.timer = setTimeout(fire, UNCONFIRMED_SEND_DEADLINE_MS)
    }
    holdsRef.current.set(clientMessageId, entry)
  }, [])
  const holdUnconfirmed = useCallback(
    (clientMessageId: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        // The saved copy waits for the chat's next open instead.
        releaseMobileNativeChatInFlightSends(
          mobileNativeChatInFlightSendIds(new Set([clientMessageId]))
        )
        return
      }
      hold(clientMessageId, () => {
        holdsRef.current.delete(clientMessageId)
        // The host's record can arrive before the lost reply settles, so read what is still unrecorded now.
        if (isHeld(clientMessageId)) {
          forget(new Set([clientMessageId]))
          onUnconfirmed()
        }
      })
    },
    [forget, hold, isHeld]
  )

  useEffect(() => {
    for (const entry of holdsRef.current.values()) {
      if (!connected) {
        clearTimeout(entry.timer ?? undefined)
        entry.timer = null
      } else if (entry.timer === null) {
        entry.timer = setTimeout(entry.fire, UNCONFIRMED_SEND_DEADLINE_MS)
      }
    }
  }, [connected])

  // The journal records a send under its id: once it does, the saved copy goes.
  const recorded = useCallback(
    (ids: readonly string[]): Set<string> => {
      const { cards, recorded } = structuredAgentSessionSettledSends(
        submissions,
        (queuedMessages ?? []).map((message) => message.messageId)
      )
      return new Set(ids.filter((id) => cards.has(id) || recorded.has(id)))
    },
    [queuedMessages, submissions]
  )

  // Sends saved before the page last closed wait like live ones once their chat opens.
  useEffect(() => {
    if (sessionId === null) {
      return
    }
    for (const send of claimMobileNativeChatInFlightSends(
      (_scope, saved) => saved.kind === 'structured' && saved.sessionId === sessionId
    )) {
      const clientMessageId = send.clientMessageId ?? send.id
      if (recorded([clientMessageId]).has(clientMessageId)) {
        settleMobileNativeChatInFlightSend(send.id)
        continue
      }
      hold(clientMessageId, () => {
        holdsRef.current.delete(clientMessageId)
        returnMobileNativeChatInFlightSend(send.id)
        onSendError(send.command ? UNCONFIRMED_SEND_MESSAGE : UNCONFIRMED_SEND_RESTORED_MESSAGE)
      })
    }
  }, [hold, onSendError, recorded, savedInFlightVersion, sessionId])

  const sends = sendsBySession[sessionKey] ?? NO_SENDS
  useEffect(() => {
    const held = [...holdsRef.current.keys()]
    if (sends.length === 0 && held.length === 0) {
      return
    }
    const settled = recorded([...sends.map((send) => send.clientMessageId), ...held])
    for (const send of sends) {
      if (structuredAgentSessionReadCoversSend(cursor, send.recordedCursor)) {
        settled.add(send.clientMessageId)
      }
    }
    if (settled.size === 0) {
      return
    }
    for (const id of settled) {
      clearTimeout(holdsRef.current.get(id)?.timer ?? undefined)
      holdsRef.current.delete(id)
    }
    for (const id of mobileNativeChatInFlightSendIds(settled)) {
      settleMobileNativeChatInFlightSend(id)
    }
    if (sends.some((send) => settled.has(send.clientMessageId))) {
      forget(settled)
    }
  }, [cursor, forget, recorded, sends])

  useEffect(() => {
    mountedRef.current = true
    const holds = holdsRef.current
    return () => {
      mountedRef.current = false
      for (const entry of holds.values()) {
        clearTimeout(entry.timer ?? undefined)
      }
      // A send still unconfirmed stays saved; the chat's next open waits on it again.
      releaseMobileNativeChatInFlightSends(mobileNativeChatInFlightSendIds(new Set(holds.keys())))
      holds.clear()
    }
  }, [])

  return {
    optimistic: sends,
    imagePreviewsByMessageId: imagePreviewsBySession[sessionKey] ?? NO_IMAGE_PREVIEWS,
    accept,
    acknowledge,
    reject,
    holdUnconfirmed
  }
}
