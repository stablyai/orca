import { useEffect, useState } from 'react'

const INPUT_LOCK_SETTLE_MS = 600

/** Why the composer input is locked: the transport is disconnected, or the
 *  terminal subscription has not acknowledged its input lease yet. */
export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

/** Locks immediately but delays unlock across transient lease loss. */
export function useSettledInputLockReason(
  raw: MobileNativeChatInputLockReason | null
): MobileNativeChatInputLockReason | null {
  const rawHeld = raw !== null
  const [lockHeld, setLockHeld] = useState(rawHeld)
  useEffect(() => {
    if (rawHeld) {
      setLockHeld(true)
      return
    }
    if (!lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(false), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawHeld])
  return raw ?? (lockHeld ? 'waiting' : null)
}
