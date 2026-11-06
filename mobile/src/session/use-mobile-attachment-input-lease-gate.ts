import { useCallback } from 'react'
import { translate } from '../i18n/mobile-i18n'

type CurrentRef<T> = { readonly current: T }

type AttachmentInputLeaseGateArgs = {
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly connStateRef: CurrentRef<string>
  readonly activeHandleRef: CurrentRef<string | null>
  readonly activeSessionTabTypeRef: CurrentRef<string | null>
  readonly nativeChatInputLeaseReadyRef: CurrentRef<boolean>
  readonly showToast: (message: string, durationMs?: number) => void
}

const LEASE_READY_POLL_MS = 100
const LEASE_READY_TIMEOUT_MS = 3000

// Wait through brief lease gaps after flushing IME; toast only unrecovered leases because the caller treats bare false as picker cancellation.
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
      // Picking/upload and IME flush may outlive their original tab.
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
      showToast(
        translate(
          'session.useAttachmentInputLeaseGate.reconnecting',
          'Attach failed (reconnecting)'
        ),
        1500
      )
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
