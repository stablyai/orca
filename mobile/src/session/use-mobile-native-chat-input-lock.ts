import { useEffect, useState } from 'react'

const INPUT_LOCK_SETTLE_MS = 600

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export function useMobileNativeChatInputLock(
  reason: MobileNativeChatInputLockReason | null | undefined
): MobileNativeChatInputLockReason | null {
  const rawReason = reason ?? null
  const rawHeld = rawReason !== null
  const [settledHeld, setSettledHeld] = useState(false)

  useEffect(() => {
    if (rawHeld === settledHeld) {
      return
    }
    const timer = setTimeout(() => setSettledHeld(rawHeld), INPUT_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [rawHeld, settledHeld])

  return settledHeld ? (rawReason ?? 'waiting') : null
}
