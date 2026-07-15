import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  expectedOccurrence: number
}
export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
}

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []

function normalizedUserText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
  return text || null
}

function countUserTextOccurrences(messages: readonly NativeChatMessage[], text: string): number {
  let count = 0
  for (const message of messages) {
    if (normalizedUserText(message) === text) {
      count++
    }
  }
  return count
}

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  pending: MobileNativeChatPendingMessage[]
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string) => void
} {
  const { hostId, worktreeId, tabId, sessionId, messages } = args
  const draftKey = tabId ? `${hostId}\0${worktreeId}\0${tabId}` : null
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const pendingCounterRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey]
  )

  const captureSendOrigin = useCallback(
    (text: string) => {
      if (!draftKey) {
        return null
      }
      const normalizedText = text.trim()
      return {
        draftKey,
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(messagesRef.current, normalizedText)
      }
    },
    [draftKey, pendingKey]
  )

  const acceptSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    // Why: an RPC may settle after a tab switch; mutate only the tab that
    // originated the send, without erasing edits typed after it began.
    setDrafts((previous) =>
      (previous[origin.draftKey] ?? '').trim() === text.trim()
        ? { ...previous, [origin.draftKey]: '' }
        : previous
    )
    // Why: the first prompt can be sent before the provider reports a session
    // id; clear its draft, but wait for an id before keying an optimistic echo.
    if (!origin.pendingKey) {
      return
    }
    const pendingKey = origin.pendingKey
    pendingCounterRef.current += 1
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? NO_PENDING_MESSAGES
      const earlierOutstanding = current.filter(
        (pending) =>
          pending.text.trim() === origin.normalizedText &&
          pending.expectedOccurrence > origin.baselineOccurrences
      ).length
      const pending = {
        id: `pending-${pendingCounterRef.current}`,
        text,
        expectedOccurrence: origin.baselineOccurrences + earlierOutstanding + 1
      }
      return { ...previous, [pendingKey]: [...current, pending] }
    })
  }, [])

  const pending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!pendingKey || pending.length === 0) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const landedCounts = new Map<string, number>()
      for (const message of messages) {
        const text = normalizedUserText(message)
        if (text) {
          landedCounts.set(text, (landedCounts.get(text) ?? 0) + 1)
        }
      }
      // Why: compare against the count captured before send; historical equal
      // turns cannot clear a new echo, while duplicates land one occurrence each.
      const next = current.filter(
        (item) => (landedCounts.get(item.text.trim()) ?? 0) < item.expectedOccurrence
      )
      if (next.length === current.length) {
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

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    pending,
    captureSendOrigin,
    acceptSend
  }
}
