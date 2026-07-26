import { useCallback } from 'react'
import { waitForMobileInputLeaseReady } from './mobile-input-lease-ready'

type CurrentRef<T> = { readonly current: T }

type AttachmentInputLeaseGateArgs = {
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly connStateRef: CurrentRef<string>
  readonly activeHandleRef: CurrentRef<string | null>
  readonly activeSessionTabTypeRef: CurrentRef<string | null>
  readonly nativeChatInputLeaseReadyRef: CurrentRef<boolean>
  readonly showToast: (message: string, durationMs?: number) => void
}

/** Gates an image attachment's terminal.send on a ready input lease. Flushes any
 *  pending IME/live input, confirms the send still targets the connected terminal
 *  tab, then waits out a short lease-not-ready window so a finished upload isn't
 *  dropped as if the picker were cancelled. Returns false only when the lease
 *  never recovers — surfacing a toast, since the caller treats a bare false as a
 *  silent picker-cancel (no error path). */
export function useMobileAttachmentInputLeaseGate({
  flushPendingLiveInputBeforeExternalSend,
  connStateRef,
  activeHandleRef,
  activeSessionTabTypeRef,
  nativeChatInputLeaseReadyRef,
  showToast
}: AttachmentInputLeaseGateArgs): (targetHandle: string) => Promise<boolean> {
  return useCallback(
    async (targetHandle: string): Promise<boolean> => {
      const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
      // Why: image picking/upload and IME flushing can outlive the original tab.
      if (
        !flushedPendingInput ||
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      const isCurrentTarget = (): boolean =>
        connStateRef.current === 'connected' &&
        targetHandle === activeHandleRef.current &&
        activeSessionTabTypeRef.current === 'terminal'
      const ready = await waitForMobileInputLeaseReady({
        isCurrent: isCurrentTarget,
        isReady: () => nativeChatInputLeaseReadyRef.current
      })
      // Why: the wait can outlive the target too — re-check so a tab/host switch
      // or disconnect mid-wait doesn't send into the wrong (or dead) terminal.
      // A moved-away target drops silently like the pre-wait guard; only a lease
      // that never recovered warrants the toast.
      if (!isCurrentTarget()) {
        return false
      }
      if (ready) {
        return true
      }
      showToast('Attach failed (reconnecting)', 1500)
      return false
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      connStateRef,
      flushPendingLiveInputBeforeExternalSend,
      nativeChatInputLeaseReadyRef,
      showToast
    ]
  )
}
