import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileNativeChatInputLockReason } from './MobileNativeChatView'

export function useMobileNativeChatInputLease(args: {
  activeHandle: string | null
  connected: boolean
}): {
  ready: boolean
  readyRef: { readonly current: boolean }
  lockReason: MobileNativeChatInputLockReason | null
  markReady: (handle: string) => void
  clear: (handle?: string) => void
} {
  const [readyHandles, setReadyHandles] = useState<Set<string>>(new Set())
  const ready = args.activeHandle != null && readyHandles.has(args.activeHandle)
  // Why: absence of an acknowledgement proves only that setup is still pending;
  // the protocol does not report evidence that another client owns the floor.
  const lockReason: MobileNativeChatInputLockReason | null = !args.connected
    ? 'disconnected'
    : ready
      ? null
      : 'waiting'
  const readyRef = useRef(ready)
  readyRef.current = ready
  useEffect(() => {
    if (!args.connected) {
      setReadyHandles(new Set())
    }
  }, [args.connected])
  const markReady = useCallback((handle: string) => {
    setReadyHandles((current) => new Set(current).add(handle))
  }, [])
  const clear = useCallback((handle?: string) => {
    setReadyHandles((current) => {
      if (handle === undefined) {
        return new Set()
      }
      if (!current.has(handle)) {
        return current
      }
      const next = new Set(current)
      next.delete(handle)
      return next
    })
  }, [])
  return {
    ready,
    readyRef,
    lockReason,
    markReady,
    clear
  }
}
