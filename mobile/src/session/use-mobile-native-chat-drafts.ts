import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileNativeChatPendingMessage = { id: string; text: string }
export type MobileNativeChatSendOrigin = { draftKey: string; pendingKey: string }

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
  captureSendOrigin: () => MobileNativeChatSendOrigin | null
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
    () => (draftKey && pendingKey ? { draftKey, pendingKey } : null),
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
    pendingCounterRef.current += 1
    const pending = { id: `pending-${pendingCounterRef.current}`, text }
    setPendingBySession((previous) => ({
      ...previous,
      [origin.pendingKey]: [...(previous[origin.pendingKey] ?? []), pending]
    }))
  }, [])

  useEffect(() => {
    if (!pendingKey) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const next = current.filter(
        (pending) =>
          !messages.some(
            (message) =>
              message.role === 'user' &&
              message.blocks.some(
                (block) => block.type === 'text' && block.text.trim() === pending.text.trim()
              )
          )
      )
      return next.length === current.length ? previous : { ...previous, [pendingKey]: next }
    })
  }, [messages, pendingKey])

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    pending: pendingKey ? (pendingBySession[pendingKey] ?? []) : [],
    captureSendOrigin,
    acceptSend
  }
}
