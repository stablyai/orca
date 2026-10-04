// Ack-lost sends: a relay drop mid-send usually loses only the acknowledgement —
// the desktop already delivered the message. Hold the send instead of claiming
// failure (which baits a duplicate): stay quiet when the transcript echo lands
// or the host shows it as a queued-draft card, and surface the uncertainty only
// if the deadline passes without either. The composer was already cleared at
// send time, so this never touches drafts.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  findLandedUnconfirmedSends,
  findQueuedUnconfirmedSends,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'

const UNCONFIRMED_SEND_DEADLINE_MS = 20_000
const NO_QUEUED_CARDS: readonly QueuedCardText[] = []

type QueuedCardText = { messageId: string; text: string }

function settledUnconfirmedSends(
  messages: readonly NativeChatMessage[],
  queuedCards: readonly QueuedCardText[],
  entries: readonly UnconfirmedSend[]
): UnconfirmedSend[] {
  const landed = findLandedUnconfirmedSends(messages, entries)
  const landedSet = new Set(landed)
  return [
    ...landed,
    ...findQueuedUnconfirmedSends(
      queuedCards,
      entries.filter((entry) => !landedSet.has(entry))
    )
  ]
}

export function useMobileNativeChatUnconfirmedSends(args: {
  draftKey: string | null
  pendingKey: string | null
  messages: readonly NativeChatMessage[]
  /** The active pane's queued-draft cards; a send the host holds as one is delivered. */
  queuedCards?: readonly QueuedCardText[]
}): {
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
} {
  const { draftKey, pendingKey, messages, queuedCards = NO_QUEUED_CARDS } = args
  const messagesRef = useRef(messages)
  const queuedCardsRef = useRef(queuedCards)
  const activeDraftKeyRef = useRef(draftKey)
  const activePendingKeyRef = useRef(pendingKey)
  // Read only by the post-send hold, which runs after the commit that set them.
  useLayoutEffect(() => {
    messagesRef.current = messages
    queuedCardsRef.current = queuedCards
    activeDraftKeyRef.current = draftKey
    activePendingKeyRef.current = pendingKey
  }, [draftKey, messages, pendingKey, queuedCards])
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
        ...(origin.baselineQueuedMessageIds
          ? { baselineQueuedMessageIds: origin.baselineQueuedMessageIds }
          : {}),
        deadline: null
      }
      // Why: the transcript event (or the card) can beat the lost RPC acknowledgement.
      if (
        isActiveTranscript &&
        settledUnconfirmedSends(messagesRef.current, queuedCardsRef.current, [entry]).length > 0
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
    const landed = settledUnconfirmedSends(messages, queuedCards, relevant)
    if (landed.length === 0) {
      return
    }
    const landedSet = new Set(landed)
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !landedSet.has(entry))
    for (const entry of landed) {
      clearTimeout(entry.deadline ?? undefined)
    }
  }, [messages, queuedCards, draftKey, pendingKey])

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
