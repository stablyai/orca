import { useCallback, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'expo-router'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'

// Expo queues back() but canGoBack() still reads committed state; latch across native batches to prevent duplicate pops.
// Release on pathname commit or owner unmount; equal-path/discarded pops may stick until unmount, which bounds the latch lifetime.
// Share one latch across mounted shells on this stack, with owner tokens so another shell’s commit cannot release it.
let pendingPop: symbol | null = null

export function useShellStackPop(): () => BridgeNavigateBackOutcome {
  const router = useRouter()
  const pathname = usePathname()
  const holder = useRef<symbol | null>(null)

  function releaseHeldPop(): void {
    if (holder.current !== null && pendingPop === holder.current) {
      pendingPop = null
    }
    holder.current = null
  }

  // Unmount also releases equal-path/discarded pops that never produce a pathname change.
  useEffect(() => {
    releaseHeldPop()
    return releaseHeldPop
  }, [pathname])

  return useCallback(() => {
    if (pendingPop !== null) {
      return 'pop-pending'
    }
    if (!router.canGoBack()) {
      return 'nothing-to-pop'
    }
    const token = Symbol('shell-stack-pop')
    pendingPop = token
    holder.current = token
    router.back()
    return 'popped'
  }, [router])
}
