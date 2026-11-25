import {
  reconcileMobileStructuredSendDelivery,
  confirmMobileRecordedRecovery
} from '../mobile-native-chat-recovery-delivery'
import type {
  MobileStructuredSends,
  MobileStructuredSendStateArgs
} from './mobile-structured-send-state'
import { retainMobileStructuredSends } from './mobile-retained-structured-sends'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalCursor } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalSubmissionKey } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import { mergeSentImagePreviews } from '../drafts/mobile-native-chat-draft-reconcile'
import {
  UNCONFIRMED_SEND_MESSAGE,
  UNCONFIRMED_SEND_RESTORED_MESSAGE
} from './use-mobile-native-chat-unconfirmed-sends'
import { createUnconfirmedSendDeadlines } from './unconfirmed-send-deadlines'
import { returnMobileNativeChatInFlightSend } from '../drafts/mobile-native-chat-draft-store'
import {
  claimMobileNativeChatInFlightSends,
  mobileNativeChatInFlightClaim,
  mobileNativeChatInFlightSendIds,
  readMobileNativeChatInFlightSend,
  releaseMobileNativeChatInFlightSends,
  useMobileNativeChatSavedInFlightVersion
} from './mobile-native-chat-in-flight-sends'
// Ordinary in-memory input outlives its request; exact host IDs retire it, and a lost reply hands it back at the deadline.

type MobileStructuredSend = StructuredAgentSessionOptimisticMessage

const NO_SENDS: readonly MobileStructuredSend[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export type { MobileStructuredSends } from './mobile-structured-send-state'

export function useMobileStructuredSends(
  args: MobileStructuredSendStateArgs
): MobileStructuredSends {
  const {
    connected = true,
    confirmRecorded,
    cursor,
    onSendError,
    queuedMessages,
    sessionId = null,
    sessionKey,
    submissions,
    draftScope
  } = args
  const [sendsBySession, setSendsBySession] = useState<
    Record<string, readonly MobileStructuredSend[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const mountedRef = useRef(false)
  const sends = sendsBySession[sessionKey] ?? NO_SENDS
  // One actual lookup per chat open; false keeps an unavailable lookup eligible when support arrives.
  const checked = useMemo(() => new Map<string, boolean>(), [sessionKey])
  const queuedMessageIds = useMemo(
    () =>
      (queuedMessages ?? []).flatMap(({ messageId, returnedFromClientMessageId }) =>
        returnedFromClientMessageId ? [messageId, returnedFromClientMessageId] : [messageId]
      ),
    [queuedMessages]
  )
  const delivery = { checked, submissions, queuedMessageIds, sends, confirmRecorded }
  const deliveryRef = useRef(delivery)
  useLayoutEffect(() => {
    deliveryRef.current = delivery
  })
  const readDelivery = useCallback(
    () =>
      mountedRef.current && deliveryRef.current.checked === checked ? deliveryRef.current : null,
    [checked]
  )
  // Held sends by journal id; their deadlines pause while the host is out.
  const [holds] = useState(createUnconfirmedSendDeadlines<string>)
  useLayoutEffect(() => {
    holds.setConnected(connected)
  }, [connected, holds])
  const savedInFlightVersion = useMobileNativeChatSavedInFlightVersion()

  const update = useCallback(
    (change: (sends: readonly MobileStructuredSend[]) => readonly MobileStructuredSend[]) => {
      if (!mountedRef.current) {
        return
      }
      setSendsBySession((previous) => {
        const current = previous[sessionKey] ?? NO_SENDS
        const updated = change(current)
        if (updated === current) {
          return previous
        }
        const next = { ...previous, [sessionKey]: updated }
        if (updated.length === 0) {
          delete next[sessionKey]
        }
        return next
      })
    },
    [sessionKey]
  )
  const forget = useCallback(
    (ids: ReadonlySet<string>) =>
      update((current) => {
        const kept = current.filter((send) => !ids.has(send.clientMessageId))
        return kept.length === current.length ? current : kept
      }),
    [update]
  )
  const replace = useCallback(
    (id: string, revise: (send?: MobileStructuredSend) => MobileStructuredSend | undefined) =>
      update((current) => {
        const index = current.findIndex((send) => send.clientMessageId === id)
        const send = revise(current[index])
        if (!send) {
          return current
        }
        const next = current.slice()
        next[index === -1 ? next.length : index] = send
        return next
      }),
    [update]
  )
  const accept = useCallback(
    (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => {
      replace(send.clientMessageId, () => send)
      if (images?.length) {
        const messageId = agentJournalSubmissionKey(send.clientMessageId)
        setImagePreviewsBySession((previous) =>
          mergeSentImagePreviews(previous, sessionKey, [{ messageId, images }])
        )
      }
    },
    [replace, sessionKey]
  )
  const acknowledge = useCallback(
    (clientMessageId: string, recordedCursor?: AgentJournalCursor) =>
      replace(
        clientMessageId,
        (send) =>
          send && {
            ...send,
            phase: 'recorded',
            ...(recordedCursor ? { recordedCursor } : {})
          }
      ),
    [replace]
  )
  const reject = useCallback(
    (clientMessageId: string) => forget(new Set([clientMessageId])),
    [forget]
  )
  // Before a send returns to the box, ask its chat's host: the record can sit past the pages loaded here.
  const holdForRecordedAnswer = useCallback(
    (
      clientMessageId: string,
      inFlightIds: () => string[],
      handBack: (savedIds: readonly string[]) => void
    ): void => {
      const owned = mobileNativeChatInFlightClaim(inFlightIds())
      holds.hold(clientMessageId, () => {
        const current = readDelivery()
        if (!current) {
          releaseMobileNativeChatInFlightSends(owned())
          return
        }
        confirmMobileRecordedRecovery({
          confirm: current.confirmRecorded,
          clientMessageId,
          inFlightIds,
          handBack,
          checked,
          forgetLocalEcho: reject,
          readDelivery,
          sessionId,
          onSendError
        })
      })
    },
    [checked, reject, holds, sessionId, onSendError, readDelivery]
  )

  const holdUnconfirmed = useCallback(
    (clientMessageId: string, onUnconfirmed: () => void) => {
      if (!readDelivery()) {
        // The saved copy waits for the chat's next open instead.
        releaseMobileNativeChatInFlightSends(
          mobileNativeChatInFlightSendIds(new Set([clientMessageId]))
        )
        return
      }
      holdForRecordedAnswer(
        clientMessageId,
        () => mobileNativeChatInFlightSendIds(new Set([clientMessageId])),
        (savedIds) => {
          // The host's record can arrive before the lost reply settles, so read what is still unrecorded now.
          if (
            savedIds.length ||
            deliveryRef.current.sends.some((send) => send.clientMessageId === clientMessageId)
          ) {
            reject(clientMessageId)
            onUnconfirmed()
          }
        }
      )
    },
    [readDelivery, reject, holdForRecordedAnswer]
  )

  // Sends saved before the page last closed wait like live ones once their chat opens.
  useEffect(() => {
    if (sessionId === null) {
      return
    }
    for (const send of claimMobileNativeChatInFlightSends((_scope, saved) => {
      const attempted = checked.get(saved.clientMessageId ?? saved.id)
      return (
        saved.kind === 'structured' &&
        saved.sessionId === sessionId &&
        (attempted === undefined || (!attempted && confirmRecorded !== null))
      )
    })) {
      const clientMessageId = send.clientMessageId ?? send.id
      holdForRecordedAnswer(
        clientMessageId,
        () => {
          const current = readMobileNativeChatInFlightSend(send.id)?.send
          return current && current.clientMessageId === send.clientMessageId ? [send.id] : []
        },
        (savedIds) => {
          if (savedIds.length) {
            returnMobileNativeChatInFlightSend(send.id)
            onSendError(send.command ? UNCONFIRMED_SEND_MESSAGE : UNCONFIRMED_SEND_RESTORED_MESSAGE)
          }
        }
      )
    }
  }, [
    checked,
    confirmRecorded,
    holdForRecordedAnswer,
    onSendError,
    savedInFlightVersion,
    sessionId
  ])

  useEffect(() => {
    reconcileMobileStructuredSendDelivery(
      sends,
      cursor,
      submissions,
      queuedMessageIds,
      sessionId,
      onSendError,
      holds,
      forget
    )
  }, [
    cursor,
    forget,
    holds,
    onSendError,
    savedInFlightVersion,
    sends,
    sessionId,
    submissions,
    queuedMessageIds
  ])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const held = new Set([...holds.keys(), ...checked.keys()])
      holds.clear()
      // A send still unconfirmed stays saved; the chat's next open waits on it again.
      releaseMobileNativeChatInFlightSends(mobileNativeChatInFlightSendIds(held))
    }
  }, [checked, holds])

  const optimistic = useMemo(
    () =>
      savedInFlightVersion && draftScope && sessionId
        ? retainMobileStructuredSends(draftScope, sessionId, sends, queuedMessageIds)
        : sends,
    [savedInFlightVersion, draftScope, sessionId, sends, queuedMessageIds]
  )
  return {
    optimistic,
    imagePreviewsByMessageId: imagePreviewsBySession[sessionKey] ?? NO_IMAGE_PREVIEWS,
    accept,
    acknowledge,
    reject,
    holdUnconfirmed
  }
}
