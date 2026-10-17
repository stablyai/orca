import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NativeChatAsyncQuestionReply } from '../../../src/shared/native-chat-async-questions'
import { MobileNativeChatAsyncQuestionContext } from './mobile-native-chat-async-question-context'

/** Allows one reply at a time across all cards and rechecks input ownership before sending. */
export function MobileNativeChatAsyncQuestionProvider({
  reply,
  disabled,
  pendingQuestions,
  children
}: {
  reply: NativeChatAsyncQuestionReply | undefined
  disabled: boolean
  pendingQuestions?: NativeChatAsyncQuestionReply['pendingQuestions']
  children: ReactNode
}): React.JSX.Element {
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)
  const latest = useRef(reply)
  const blocked = disabled || !reply || reply.disabled
  const blockedRef = useRef(blocked)
  useLayoutEffect(() => {
    latest.current = reply
    blockedRef.current = blocked
    return () => {
      blockedRef.current = true
    }
  }, [reply, blocked])
  const value = useMemo<NativeChatAsyncQuestionReply>(
    () => ({
      disabled: blocked || sending,
      pendingQuestions,
      send: async (text) => {
        if (blockedRef.current || inFlight.current || !latest.current) {
          return false
        }
        inFlight.current = true
        setSending(true)
        try {
          return await latest.current.send(text)
        } catch {
          return false
        } finally {
          inFlight.current = false
          setSending(false)
        }
      }
    }),
    [blocked, sending, pendingQuestions]
  )
  return (
    <MobileNativeChatAsyncQuestionContext.Provider value={reply ? value : null}>
      {children}
    </MobileNativeChatAsyncQuestionContext.Provider>
  )
}
