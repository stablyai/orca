import { useCallback, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useMediaPicker } from '../platform/media-picker'
import {
  ImageLibraryPermissionError,
  type MobileImageSource
} from '../platform/media-picker-contract'
import { attachMobileImageToTerminal } from './mobile-image-attachment'

type CurrentRef<T> = {
  readonly current: T
}

type ShowToast = (message: string, durationMs?: number) => void

type UseMobileImageAttachmentArgs = {
  readonly agent?: string | null
  readonly client: RpcClient | null
  readonly activeHandle: string | null
  readonly canSend: boolean
  readonly connState: ConnectionState
  readonly deviceTokenRef: CurrentRef<string | null>
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly showToast: ShowToast
  readonly onSuccess: () => void
  readonly onError: () => void
  readonly beforeTerminalSend?: (terminal: string) => Promise<boolean>
}

type MobileImageAttachment = {
  readonly attachImage: (source: MobileImageSource) => Promise<void>
  // True only while the picked image is uploading to the host (not while the
  // picker is open) — drives the send spinner so the 3-5s transfer isn't a no-op.
  readonly isAttaching: boolean
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useMobileImageAttachment({
  client,
  agent,
  activeHandle,
  canSend,
  connState,
  deviceTokenRef,
  getActiveWorktreeConnectionId,
  showToast,
  onSuccess,
  onError,
  beforeTerminalSend
}: UseMobileImageAttachmentArgs): MobileImageAttachment {
  const [isAttaching, setIsAttaching] = useState(false)
  const picker = useMediaPicker()
  const attachImage = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      if (!client || !activeHandle || !canSend) {
        return
      }
      try {
        const sent = await attachMobileImageToTerminal(source, {
          client,
          agent,
          terminal: activeHandle,
          deviceToken: deviceTokenRef.current,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImage: picker.pickImage,
          onUploadStart: () => setIsAttaching(true),
          beforeTerminalSend
        })
        // Cancelled picker: no error, no toast.
        if (sent) {
          onSuccess()
        }
      } catch (error) {
        onError()
        if (connState !== 'connected') {
          showToast('Attach failed (disconnected)', 1500)
          return
        }
        if (error instanceof ImageLibraryPermissionError) {
          showToast('Photo permission denied', 1500)
          return
        }
        if (getErrorMessage(error) === 'Clipboard image is too large') {
          showToast('Image too large to attach', 1500)
          return
        }
        showToast('Attach failed', 1500)
      } finally {
        setIsAttaching(false)
      }
    },
    [
      activeHandle,
      agent,
      beforeTerminalSend,
      canSend,
      client,
      connState,
      deviceTokenRef,
      getActiveWorktreeConnectionId,
      onError,
      onSuccess,
      picker,
      showToast
    ]
  )

  return { attachImage, isAttaching }
}
