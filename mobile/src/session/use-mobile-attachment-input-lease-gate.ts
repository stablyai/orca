import { useCallback } from 'react'

type CurrentRef<T> = { readonly current: T }

type AttachmentInputLeaseGateArgs = {
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly connStateRef: CurrentRef<string>
  readonly activeHandleRef: CurrentRef<string | null>
  readonly activeSessionTabTypeRef: CurrentRef<string | null>
  readonly nativeChatInputLeaseReadyRef: CurrentRef<boolean>
  readonly showToast: (message: string, durationMs?: number) => void
  readonly recoverTerminalInputLease?: (handle: string, forceResubscribe: boolean) => void
}

const LEASE_READY_POLL_MS = 100
const LEASE_READY_TIMEOUT_MS = 3000
const LEASE_FORCE_RESUBSCRIBE_POLL_COUNT = 5

// Wait through brief lease gaps after flushing IME; toast only unrecovered leases because the caller treats bare false as picker cancellation.
export function useMobileAttachmentInputLeaseGate({
  flushPendingLiveInputBeforeExternalSend,
  connStateRef,
  activeHandleRef,
  activeSessionTabTypeRef,
  nativeChatInputLeaseReadyRef,
  showToast,
  recoverTerminalInputLease
}: AttachmentInputLeaseGateArgs): (targetHandle: string) => Promise<boolean> {
  return useCallback(
    async (targetHandle: string): Promise<boolean> => {
      const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
      // Picking/upload and IME flush may outlive their original tab.
      if (
        !flushedPendingInput ||
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      if (!nativeChatInputLeaseReadyRef.current) {
        recoverTerminalInputLease?.(targetHandle, false)
      }
      const deadline = Date.now() + LEASE_READY_TIMEOUT_MS
      let polls = 0
      while (!nativeChatInputLeaseReadyRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LEASE_READY_POLL_MS))
        polls += 1
        if (
          polls === LEASE_FORCE_RESUBSCRIBE_POLL_COUNT &&
          !nativeChatInputLeaseReadyRef.current &&
          connStateRef.current === 'connected' &&
          targetHandle === activeHandleRef.current &&
          activeSessionTabTypeRef.current === 'terminal'
        ) {
          recoverTerminalInputLease?.(targetHandle, true)
        }
      }
      // Recheck after waiting to avoid writing to a switched/dead target; moved targets cancel silently, failed lease recovery toasts.
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
      recoverTerminalInputLease,
      showToast
    ]
  )
}
