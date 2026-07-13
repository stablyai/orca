import { useCallback, useEffect, useRef, useState } from 'react'

export function useMobileNativeChatInputLease(args: {
  activeHandle: string | null
  connected: boolean
}): {
  ready: boolean
  readyRef: { readonly current: boolean }
  markReady: (handle: string) => void
  clear: (handle?: string) => void
} {
  const [readyHandles, setReadyHandles] = useState<Set<string>>(new Set())
  const ready = args.activeHandle != null && readyHandles.has(args.activeHandle)
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
    markReady,
    clear
  }
}
