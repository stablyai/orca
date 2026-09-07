import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

const NATIVE_CHAT_SEND_ERROR_HOLD_MS = 4000
const NATIVE_CHAT_SEND_ERROR_TOAST_MS = 1600

/** Holds the newest native-chat send failure for the composer's inline banner.
 *  Why a banner and not the bottom toast: chat failures happen with the keyboard
 *  up, which covers the toast — the surface the user is looking at is the composer.
 *  Scoped like drafts and image chips: a failure belongs to the terminal it was
 *  raised on and must not follow the user to another tab. */
export function useMobileNativeChatSendError(args: {
  scopeKey: string | null
  showToast: (message: string, durationMs?: number) => void
}): {
  message: string | null
  show: (message: string) => void
  clear: () => void
  /** Set by the route each render; gates banner vs toast. */
  bannerMountedRef: MutableRefObject<boolean>
} {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerMountedRef = useRef(false)
  const showToastRef = useRef(args.showToast)
  showToastRef.current = args.showToast
  // Why: `show`/`clear` are handed to sends that resolve much later (a 20s
  // unconfirmed send, a paced answer). Comparing the scope they were built for
  // against the live one is what stops tab A's late outcome from painting — or
  // wiping — tab B's banner.
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
    setMessage(null)
  }, [clearTimer, scopeKey])
  const show = useCallback(
    (next: string) => {
      // Why: deferred failures can land after the user left chat (banner unmounted)
      // or moved to another tab, where the banner belongs to a different terminal —
      // both must fall back to the toast instead of being swallowed or misattributed.
      if (liveScopeRef.current !== scopeKey || !bannerMountedRef.current) {
        showToastRef.current(next, NATIVE_CHAT_SEND_ERROR_TOAST_MS)
        return
      }
      clearTimer()
      setMessage(next)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setMessage(null)
      }, NATIVE_CHAT_SEND_ERROR_HOLD_MS)
    },
    [clearTimer, scopeKey]
  )
  // A held failure describes the scope it was raised on; drop it when that changes.
  useEffect(() => {
    clearTimer()
    setMessage(null)
  }, [clearTimer, scopeKey])
  useEffect(
    () => () => {
      // Why: the route writes this ref during render, so an unmount leaves it stuck
      // true and a pending send's late failure would target a banner that no longer
      // exists — swallowing the one signal the toast fallback is here to carry.
      bannerMountedRef.current = false
      clearTimer()
    },
    [clearTimer]
  )
  return { message, show, clear, bannerMountedRef }
}
