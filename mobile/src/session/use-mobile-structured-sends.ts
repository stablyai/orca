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
  UNCONFIRMED_SEND_MESSAGE,
  UNCONFIRMED_SEND_RESTORED_MESSAGE
} from './native-chat/use-mobile-native-chat-unconfirmed-sends'
import { createUnconfirmedSendDeadlines } from './native-chat/unconfirmed-send-deadlines'
import { returnMobileNativeChatInFlightSend } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  claimMobileNativeChatInFlightSends,
  mobileNativeChatInFlightSendIds,
  readMobileNativeChatInFlightSend,
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

export function useMobileStructuredSends(args: {
  sessionKey: string
  sessionId?: string | null
  connected?: boolean
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  onSendError: MobileNativeChatSendErrorReporter
  /** Asks the host whether it recorded a send; null where only the loaded pages can say. */
  confirmRecorded?: ((clientMessageId: string) => Promise<boolean> | null) | null
}): MobileStructuredSends {
  const {
    confirmRecorded = null,
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
  // Held sends by journal id; their deadlines pause while the host is out.
  const [holds] = useState(createUnconfirmedSendDeadlines<string>)
  // Expired holds whose host lookup is out: a row arriving meanwhile still settles them.
  const [asking] = useState(() => new Set<string>())
  useLayoutEffect(() => {
    holds.setConnected(connected)
  }, [connected, holds])
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
        const current = previous[sessionKey] ?? []
        const kept = current.filter((send) => !ids.has(send.clientMessageId))
        if (kept.length === current.length) {
          return previous
        }
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

  // Before a send returns to the box, ask its chat's host: the record can sit past the pages loaded here.
  const handBackUnlessRecorded = useCallback(
    (
      confirm: typeof confirmRecorded,
      clientMessageId: string,
      inFlightIds: () => string[],
      handBack: () => void
    ): void => {
      const asked = confirm?.(clientMessageId)
      if (!asked) {
        handBack()
        return
      }
      asking.add(clientMessageId)
      void asked.then((onHost) => {
        asking.delete(clientMessageId)
        if (onHost) {
          for (const id of inFlightIds()) {
            settleMobileNativeChatInFlightSend(id)
          }
          forget(new Set([clientMessageId]))
        } else {
          // Even after the chat closed: the hand-back it captured keeps a queued send's place.
          handBack()
        }
      })
    },
    [asking, forget]
  )

  const isHeld = useCallback(
    (clientMessageId: string) =>
      (sendsBySessionRef.current[sessionKey] ?? []).some(
        (send) => send.clientMessageId === clientMessageId
      ),
    [sessionKey]
  )
  const holdUnconfirmed = useCallback(
    (clientMessageId: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        // The saved copy waits for the chat's next open instead.
        releaseMobileNativeChatInFlightSends(
          mobileNativeChatInFlightSendIds(new Set([clientMessageId]))
        )
        return
      }
      holds.hold(clientMessageId, () =>
        handBackUnlessRecorded(
          confirmRecorded,
          clientMessageId,
          () => mobileNativeChatInFlightSendIds(new Set([clientMessageId])),
          () => {
            // The host's record can arrive before the lost reply settles, so read what is still unrecorded now.
            if (isHeld(clientMessageId)) {
              forget(new Set([clientMessageId]))
              onUnconfirmed()
            }
          }
        )
      )
    },
    [confirmRecorded, forget, handBackUnlessRecorded, holds, isHeld]
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
      holds.hold(clientMessageId, () =>
        handBackUnlessRecorded(
          confirmRecorded,
          clientMessageId,
          () => [send.id],
          () => {
            if (readMobileNativeChatInFlightSend(send.id)) {
              returnMobileNativeChatInFlightSend(send.id)
              onSendError(
                send.command ? UNCONFIRMED_SEND_MESSAGE : UNCONFIRMED_SEND_RESTORED_MESSAGE
              )
            }
          }
        )
      )
    }
  }, [
    confirmRecorded,
    handBackUnlessRecorded,
    holds,
    onSendError,
    recorded,
    savedInFlightVersion,
    sessionId
  ])

  const sends = sendsBySession[sessionKey] ?? NO_SENDS
  useEffect(() => {
    const held = [...holds.keys(), ...asking]
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
      holds.cancel(id)
    }
    for (const id of mobileNativeChatInFlightSendIds(settled)) {
      settleMobileNativeChatInFlightSend(id)
    }
    if (sends.some((send) => settled.has(send.clientMessageId))) {
      forget(settled)
    }
  }, [asking, cursor, forget, holds, recorded, sends])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const held = holds.keys()
      holds.clear()
      // A send still unconfirmed stays saved; the chat's next open waits on it again.
      releaseMobileNativeChatInFlightSends(mobileNativeChatInFlightSendIds(new Set(held)))
    }
  }, [holds])

  return {
    optimistic: sends,
    imagePreviewsByMessageId: imagePreviewsBySession[sessionKey] ?? NO_IMAGE_PREVIEWS,
    accept,
    acknowledge,
    reject,
    holdUnconfirmed
  }
}
