import { useCallback, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { isClipboardImageTooLargeError } from '../../../src/shared/clipboard-image'
import { attachMobileImageToTerminal } from './mobile-image-attachment'
import {
  ImageLibraryPermissionError,
  pickMobileImage,
  type MobileImageSource
} from './mobile-image-source-picker'
import { t } from '@/i18n/mobile-i18n'

type CurrentRef<T> = {
  readonly current: T
}

type ShowToast = (message: string, durationMs?: number) => void

type UseMobileImageAttachmentArgs = {
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

export function useMobileImageAttachment({
  client,
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
  const attachImage = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      if (!client || !activeHandle || !canSend) {
        return
      }
      try {
        const sent = await attachMobileImageToTerminal(source, {
          client,
          terminal: activeHandle,
          deviceToken: deviceTokenRef.current,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImage: pickMobileImage,
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
          showToast(t('useMobileImageAttachment.attachFailedDisconnected'), 1500)
          return
        }
        if (error instanceof ImageLibraryPermissionError) {
          showToast(t('useMobileImageAttachment.photo'), 1500)
          return
        }
        if (isClipboardImageTooLargeError(error)) {
          showToast(t('useMobileImageAttachment.image'), 1500)
          return
        }
        showToast(t('useMobileImageAttachment.attachFailed'), 1500)
      } finally {
        setIsAttaching(false)
      }
    },
    [
      activeHandle,
      beforeTerminalSend,
      canSend,
      client,
      connState,
      deviceTokenRef,
      getActiveWorktreeConnectionId,
      onError,
      onSuccess,
      showToast
    ]
  )

  return { attachImage, isAttaching }
}
