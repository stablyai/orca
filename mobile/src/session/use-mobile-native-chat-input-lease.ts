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
  // Distinguish a transport drop from a genuine other-client hold so the composer
  // never mislabels a reconnect as "locked by another client".
  const lockReason: MobileNativeChatInputLockReason | null = !args.connected
    ? 'disconnected'
    : ready
      ? null
      : 'other-client'
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
