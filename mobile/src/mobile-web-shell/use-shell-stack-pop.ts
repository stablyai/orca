import { useCallback, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'expo-router'
import type { BridgeNavigateBackOutcome } from './bridge-host-contract'

/**
 * The shell's own stack pop, and the latch that keeps one `navigate-back` from becoming two.
 *
 * `canGoBack()` and `back()` disagree about time. The first reads the committed navigation state;
 * the second only adds `GO_BACK` to `routingQueue`, which `useImperativeApiEmitter` drains from an
 * effect. Two frames delivered in one native batch therefore both read the stack the first pop has
 * not left yet, both queue, and a three-deep stack unwinds past the screen the page was opened
 * over. Nothing upstream coalesces: the host forwards every notify it is granted.
 *
 * The latch clears on the committed route rather than on a timer, because that commit is the first
 * moment `canGoBack()` answers for the stack the pop actually left. A pop that takes this screen
 * off the stack unmounts it and takes the ref with it, which is the same answer by another route.
 *
 * Two pops do not reach that clear, and neither is a reason to retry:
 *
 * - A pop landing on an equal pathname. `usePathname()` does not transition, so the effect below
 *   does not run. React Navigation would have told us — `@react-navigation/core` emits `state` from
 *   an effect keyed on the navigator state object, which every pop replaces — but the emitter is
 *   the navigator, not the routing module the latch is written against, so that signal cannot be
 *   proved here the way the queue can.
 * - A `GO_BACK` the queue discards. `routingQueue.run` shifts every action off the queue whether or
 *   not `ref.current` is set, so a drain during teardown drops the pop and no route ever commits.
 *   The navigator's `state` event does not fire for this one either.
 *
 * Both are bounded rather than fixed: the latch is released when the holder unmounts, so a stick
 * lasts at most as long as the screen that took it. That bound is what makes one latch over the
 * whole stack safe — without it a discarded pop would leave Back dead for the rest of the session.
 */
export function useShellStackPop(): () => BridgeNavigateBackOutcome {
  const router = useRouter()
  const pathname = usePathname()
  const popPending = useRef(false)
  useEffect(() => {
    popPending.current = false
  }, [pathname])
  return useCallback(() => {
    if (popPending.current) {
      return 'pop-pending'
    }
    if (!router.canGoBack()) {
      return 'nothing-to-pop'
    }
    popPending.current = true
    router.back()
    return 'popped'
  }, [router])
}
