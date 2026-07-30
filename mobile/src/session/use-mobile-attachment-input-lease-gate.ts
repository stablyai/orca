import { useCallback } from 'react'

type CurrentRef<T> = { readonly current: T }

type AttachmentInputLeaseGateArgs = {
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly connStateRef: CurrentRef<string>
  readonly activeHandleRef: CurrentRef<string | null>
  readonly activeSessionTabTypeRef: CurrentRef<string | null>
  readonly nativeChatInputLeaseReadyRef: CurrentRef<boolean>
  readonly showToast: (message: string, durationMs?: number) => void
}

// Poll cadence + ceiling for riding out a terminal resubscribe (WS reconnect or
// return-to-terminal) during which the input lease is briefly not ready.
const LEASE_READY_POLL_MS = 100
const LEASE_READY_TIMEOUT_MS = 3000

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
      const deadline = Date.now() + LEASE_READY_TIMEOUT_MS
      while (!nativeChatInputLeaseReadyRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LEASE_READY_POLL_MS))
      }
      // Why: the wait can outlive the target too — re-check so a tab/host switch
      // or disconnect mid-wait doesn't send into the wrong (or dead) terminal.
      // A moved-away target drops silently like the pre-wait guard; only a lease
      // that never recovered warrants the toast.
      if (
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      if (nativeChatInputLeaseReadyRef.current) {
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
