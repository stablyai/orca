import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { useMobileStructuredSendWithOutcome } from './use-mobile-structured-send-with-outcome'
import type { NativeChatAsyncQuestionReply } from '../../../src/shared/native-chat-async-questions'

/** Sends answers immediately and ignores completion callbacks after the session changes or stops. */
export function useMobileNativeChatAsyncReply(
  scope: string,
  disabled: boolean,
  structuredSend: ReturnType<typeof useMobileStructuredSendWithOutcome> | null,
  terminalSend: (text: string, isCurrent?: () => boolean) => Promise<boolean>,
  onResolved: () => void,
  stopAgent: () => void
): { reply: NativeChatAsyncQuestionReply; stop: () => void } {
  const latest = useRef({ scope, disabled })
  useLayoutEffect(() => {
    latest.current = { scope, disabled }
    return () => {
      latest.current.disabled = true
    }
  }, [scope, disabled])
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (latest.current.scope !== scope || latest.current.disabled) {
        return false
      }
      const origin = latest.current
      const isCurrent = (): boolean => latest.current === origin && !origin.disabled
      const accepted = structuredSend
        ? (await structuredSend(text, undefined, undefined, undefined, { immediate: true })) ===
          'accepted'
        : await terminalSend(text, isCurrent)
      if (accepted && isCurrent()) {
        onResolved()
      }
      return accepted
    },
    [scope, structuredSend, terminalSend, onResolved]
  )
  const stop = useCallback(() => {
    latest.current = { ...latest.current }
    stopAgent()
  }, [stopAgent])
  const reply = useMemo(() => ({ disabled, send }), [disabled, send])
  return { reply, stop }
}
