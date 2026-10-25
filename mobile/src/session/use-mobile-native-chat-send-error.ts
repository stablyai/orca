import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { StructuredAgentSessionCommandRefusalCause } from '../../../src/shared/structured-agent-session-composer'

// Keep command-refusal causes only while the chat still shows the work that caused them.
export type MobileNativeChatSendErrorDetails = {
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
}

export type MobileNativeChatSendErrorReporter = (
  message: string,
  details?: MobileNativeChatSendErrorDetails
) => void

export type MobileNativeChatCommandRefusalCauses = Readonly<
  Partial<Record<StructuredAgentSessionCommandRefusalCause, boolean>>
>

const NATIVE_CHAT_SEND_ERROR_HOLD_MS = 4000
const NATIVE_CHAT_SEND_ERROR_TOAST_MS = 1600

// Show failures beside the composer because the keyboard covers toasts; scope banners per terminal so tab switches cannot misattribute them.
export function useMobileNativeChatSendError(args: {
  scopeKey: string | null
  showToast: (message: string, durationMs?: number) => void
}): {
  message: string | null
  show: MobileNativeChatSendErrorReporter
  clear: () => void
  keepWhile: (causes: MobileNativeChatCommandRefusalCauses | null) => void
  bannerMountedRef: MutableRefObject<boolean>
} {
  const [error, setError] = useState<
    ({ scopeKey: string | null; message: string } & MobileNativeChatSendErrorDetails) | null
  >(null)
  if (error && error.scopeKey !== args.scopeKey) {
    setError(null)
  }
  const visibleError = error?.scopeKey === args.scopeKey ? error : null
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerMountedRef = useRef(false)
  const showToastRef = useRef(args.showToast)
  showToastRef.current = args.showToast
  // Late write callbacks compare captured and live scope before painting or clearing another tab’s banner.
  const liveScopeRef = useRef(args.scopeKey)
  liveScopeRef.current = args.scopeKey
  const scopeKey = args.scopeKey
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])
  const clear = useCallback(() => {
    if (liveScopeRef.current !== scopeKey) {
      return
    }
    clearTimer()
    setError(null)
  }, [clearTimer, scopeKey])
  const show = useCallback(
    (next: string, details?: MobileNativeChatSendErrorDetails) => {
      // Fall back to toast after leaving chat or changing tabs so late failures remain visible without misattribution.
      if (liveScopeRef.current !== scopeKey || !bannerMountedRef.current) {
        showToastRef.current(next, NATIVE_CHAT_SEND_ERROR_TOAST_MS)
        return
      }
      clearTimer()
      setError({ scopeKey, message: next, ...details })
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setError(null)
      }, NATIVE_CHAT_SEND_ERROR_HOLD_MS)
    },
    [clearTimer, scopeKey]
  )
  useEffect(() => {
    clearTimer()
  }, [clearTimer, scopeKey])
  useEffect(
    () => () => {
      // Clear the render-written mounted ref on unmount or deferred failures target a missing banner and disappear.
      bannerMountedRef.current = false
      clearTimer()
    },
    [clearTimer]
  )
  const keepWhile = (causes: MobileNativeChatCommandRefusalCauses | null) => {
    // Drop ended causes permanently; their later recurrence does not revive this refusal.
    const refusedWhile = visibleError?.refusedWhile
    if (refusedWhile !== undefined && causes?.[refusedWhile] === false) {
      setError(null)
    }
  }
  return {
    message: visibleError?.message ?? null,
    show,
    clear,
    keepWhile,
    bannerMountedRef
  }
}
