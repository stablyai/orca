import type { RefObject } from 'react'

const INITIAL_TERMINAL_RETRY_MS = 500
const MAX_TERMINAL_RETRY_MS = 30_000

export function mobileTerminalRetryDelay(attempt: number): number {
  return Math.min(
    INITIAL_TERMINAL_RETRY_MS * 2 ** Math.max(0, Math.floor(attempt)),
    MAX_TERMINAL_RETRY_MS
  )
}

export function recordMobileTerminalActivationFailure(
  failuresRef: RefObject<{ key: string; count: number } | null>,
  attemptRef: RefObject<string | null>,
  key: string
): number {
  const previous = failuresRef.current
  const count = previous?.key === key ? previous.count : 0
  failuresRef.current = { key, count: count + 1 }
  if (attemptRef.current === key) {
    attemptRef.current = null
  }
  return mobileTerminalRetryDelay(count)
}
