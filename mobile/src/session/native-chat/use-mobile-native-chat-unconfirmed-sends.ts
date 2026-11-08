// Lost acknowledgements may hide delivered sends: hold them quietly until the transcript confirms them, or hand them back at the deadline. Structured sends own a separate hold.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import {
  findLandedUnconfirmedSends,
  type UnconfirmedSend
} from './composer/mobile-native-chat-draft-reconcile'
import { returnMobileNativeChatInFlightSend } from './composer/mobile-native-chat-draft-store'
import {
  claimMobileNativeChatInFlightSends,
  releaseMobileNativeChatInFlightSends,
  settleMobileNativeChatInFlightSend,
  useMobileNativeChatSavedInFlightVersion
} from './composer/mobile-native-chat-in-flight-sends'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'
import { createUnconfirmedSendDeadlines } from './unconfirmed-send-deadlines'

export const UNCONFIRMED_SEND_MESSAGE = 'Delivery unconfirmed — check chat before retrying'
export const UNCONFIRMED_SEND_RESTORED_MESSAGE = 'Not confirmed. Restored to the box.'

type HeldSend = UnconfirmedSend & {
  inFlightId: string | null
  onUnconfirmed: () => void
  // Saved before the page closed: its tail may have scrolled out of the loaded window.
  restored: boolean
}

function landedHolds(
  messages: readonly NativeChatMessage[],
  entries: readonly HeldSend[]
): Set<HeldSend> {
  const loaded = new Set(messages.map((message) => message.id))
  // A tail outside the window can't bound the echo, so any echo in the window confirms a restored send.
  const probes = entries.map((entry) =>
    entry.restored &&
    entry.baselineTailMessageId !== null &&
    !loaded.has(entry.baselineTailMessageId)
      ? { ...entry, baselineTailMessageId: null }
      : entry
  )
  const landed = new Set<UnconfirmedSend>(findLandedUnconfirmedSends(messages, probes))
  return new Set(entries.filter((_entry, index) => landed.has(probes[index]!)))
}

export function useMobileNativeChatUnconfirmedSends(args: {
  draftKey: string | null
  pendingKey: string | null
  messages: readonly NativeChatMessage[]
  // The deadline runs only while connected: the transcript cannot confirm anything while the host is out.
  connected: boolean
  // Saved sends are checked only against this chat's own settled transcript.
  transcriptReady: boolean
  onSendError: (message: string) => void
}): {
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void,
    inFlightId?: string | null
  ) => void
} {
  const { draftKey, pendingKey, messages, connected, transcriptReady, onSendError } = args
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
  const unconfirmedRef = useRef<HeldSend[]>([])
  const [deadlines] = useState(createUnconfirmedSendDeadlines<HeldSend>)
  const savedInFlightVersion = useMobileNativeChatSavedInFlightVersion()
  useLayoutEffect(() => {
    deadlines.setConnected(connected)
  }, [connected, deadlines])

  const hold = useCallback(
    (entry: HeldSend) => {
      // The confirming transcript event can arrive before the lost-ack RPC settles.
      const isActiveTranscript =
        activeDraftKeyRef.current === entry.draftKey &&
        (entry.pendingKey === null || activePendingKeyRef.current === entry.pendingKey)
      // Matched after the sends already held, so one echo confirms at most one send.
      if (
        isActiveTranscript &&
        landedHolds(messagesRef.current, [
          ...unconfirmedRef.current.filter(
            (held) => held.draftKey === entry.draftKey && held.pendingKey === entry.pendingKey
          ),
          entry
        ]).has(entry)
      ) {
        settleMobileNativeChatInFlightSend(entry.inFlightId)
        return
      }
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
      deadlines.hold(entry, () => {
        unconfirmedRef.current = unconfirmedRef.current.filter((held) => held !== entry)
        entry.onUnconfirmed()
        settleMobileNativeChatInFlightSend(entry.inFlightId)
      })
    },
    [deadlines]
  )

  const holdUnconfirmedSend = useCallback(
    (
      origin: MobileNativeChatSendOrigin,
      text: string,
      onUnconfirmed: () => void,
      inFlightId: string | null = null
    ) => {
      if (!mountedRef.current) {
        releaseMobileNativeChatInFlightSends(inFlightId ? [inFlightId] : [])
        return
      }
      hold({
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.boundary.afterMessageId ?? null,
        deadline: null,
        inFlightId,
        onUnconfirmed,
        restored: false
      })
    },
    [hold]
  )

  // Sends saved before the page last closed wait here like live ones once their chat opens.
  useEffect(() => {
    if (!draftKey || !transcriptReady) {
      return
    }
    for (const send of claimMobileNativeChatInFlightSends(
      (scope, saved) => scope === draftKey && saved.kind === 'terminal'
    )) {
      hold({
        draftKey,
        pendingKey: send.sessionId === null ? null : `${draftKey}\0${send.sessionId}`,
        text: send.text,
        normalizedText: send.normalizedText,
        baselineTailMessageId: send.baselineTailMessageId,
        deadline: null,
        inFlightId: send.id,
        restored: true,
        // A TUI holds a mid-turn send with no transcript row until the turn ends, so its absence proves nothing.
        onUnconfirmed: send.queuedDuringWork
          ? () => onSendError(UNCONFIRMED_SEND_MESSAGE)
          : () => {
              returnMobileNativeChatInFlightSend(send.id)
              onSendError(
                send.command ? UNCONFIRMED_SEND_MESSAGE : UNCONFIRMED_SEND_RESTORED_MESSAGE
              )
            }
      })
    }
  }, [draftKey, hold, onSendError, savedInFlightVersion, transcriptReady])

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevant = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey &&
        (entry.pendingKey === null || entry.pendingKey === pendingKey)
    )
    const landedSet = landedHolds(messages, relevant)
    if (landedSet.size === 0) {
      return
    }
    for (const entry of unconfirmedRef.current) {
      if (landedSet.has(entry)) {
        deadlines.cancel(entry)
        settleMobileNativeChatInFlightSend(entry.inFlightId)
      }
    }
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !landedSet.has(entry))
  }, [deadlines, messages, draftKey, pendingKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      deadlines.clear()
      // A send still unconfirmed stays saved; the chat's next open waits on it again.
      releaseMobileNativeChatInFlightSends(
        unconfirmedRef.current.flatMap((entry) => (entry.inFlightId ? [entry.inFlightId] : []))
      )
      unconfirmedRef.current = []
    }
  }, [deadlines])

  return { holdUnconfirmedSend }
}
