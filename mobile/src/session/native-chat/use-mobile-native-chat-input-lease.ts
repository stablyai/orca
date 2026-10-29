import { useCallback, useEffect, useRef, useState } from 'react'
import {
  NATIVE_CHAT_COMPOSER_PLACEHOLDER,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../src/shared/native-chat-turn-status'
import type { MobileNativeChatInputLockReason } from '../MobileNativeChatView'

export function useMobileNativeChatInputLease(args: {
  activeHandle: string | null
  connected: boolean
}): {
  ready: boolean
  readyRef: { readonly current: boolean }
  lockReason: MobileNativeChatInputLockReason | null
  markReady: (handle: string) => void
  // Report synchronous no-op clears so callers can detect teardown React never observes.
  clear: (handle?: string) => boolean
} {
  const [readyHandles, setReadyHandles] = useState<Set<string>>(new Set())
  // Mirrors the state so `clear` can report synchronously whether it changed anything.
  const readyHandlesRef = useRef(readyHandles)
  const ready = args.activeHandle != null && readyHandles.has(args.activeHandle)
  // Missing acknowledgement proves only pending setup, never ownership by another client.
  const lockReason: MobileNativeChatInputLockReason | null = !args.connected
    ? 'disconnected'
    : ready
      ? null
      : 'waiting'
  const readyRef = useRef(ready)
  readyRef.current = ready
  const replace = useCallback((next: Set<string>) => {
    readyHandlesRef.current = next
    setReadyHandles(next)
  }, [])
  useEffect(() => {
    if (!args.connected && readyHandlesRef.current.size > 0) {
      replace(new Set())
    }
  }, [args.connected, replace])
  const markReady = useCallback(
    (handle: string) => {
      if (readyHandlesRef.current.has(handle)) {
        return
      }
      replace(new Set(readyHandlesRef.current).add(handle))
    },
    [replace]
  )
  const clear = useCallback(
    (handle?: string): boolean => {
      const current = readyHandlesRef.current
      if (handle === undefined) {
        if (current.size === 0) {
          return false
        }
        replace(new Set())
        return true
      }
      if (!current.has(handle)) {
        return false
      }
      const next = new Set(current)
      next.delete(handle)
      replace(next)
      return true
    },
    [replace]
  )
  return {
    ready,
    readyRef,
    lockReason,
    markReady,
    clear
  }
}

const INPUT_LOCK_SETTLE_MS = 600

// Settle subscribed/end together so dead PTYs cannot flash the composer enabled.
export function useSettledMobileNativeChatInputLock(
  reason: MobileNativeChatInputLockReason | null | undefined
): MobileNativeChatInputLockReason | null {
  const rawLockReason = reason ?? null
  const rawLockHeld = rawLockReason !== null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawLockHeld === lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(rawLockHeld), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawLockHeld])
  return lockHeld ? (rawLockReason ?? 'waiting') : null
}

export function mobileNativeChatComposerPlaceholder(
  lockReason: MobileNativeChatInputLockReason | null,
  afterStop?: 'queue' | 'send'
): string {
  if (lockReason === 'disconnected') {
    return 'Reconnecting…'
  }
  if (lockReason === 'waiting') {
    return 'Waiting for terminal…'
  }
  if (afterStop) {
    return afterStop === 'queue'
      ? NATIVE_CHAT_TURN_STATUS_COPY.queueAfterStop
      : NATIVE_CHAT_TURN_STATUS_COPY.sendAfterStop
  }
  return NATIVE_CHAT_COMPOSER_PLACEHOLDER
}
