import { useCallback, useRef, useState } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { useMediaPicker } from '../../platform/media-picking/media-picker'
import {
  ImageLibraryPermissionError,
  MobileFileTooLargeError,
  MobileUploadCancelledError,
  type MobileImageSource
} from '../../platform/media-picking/media-picker-contract'
import {
  attachMobileFilesToTerminal,
  attachMobileGalleryToTerminal,
  attachMobileImageToTerminal
} from './mobile-image-attachment'
import { fitMobileAgentImage } from './mobile-agent-image-fit'

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
  readonly attachImage: (source: MobileImageSource | 'gallery') => Promise<void>
  // Show upload progress after picker completion so the host transfer cannot look like a no-op.
  readonly isAttaching: boolean
  // Stops the running upload between chunks; the host drops the partial file.
  readonly cancelAttach: () => void
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
  const cancelRequested = useRef(false)
  const cancelAttach = useCallback(() => {
    cancelRequested.current = true
  }, [])
  const attachImage = useCallback(
    async (source: MobileImageSource | 'gallery'): Promise<void> => {
      if (!client || !activeHandle || !canSend) {
        return
      }
      cancelRequested.current = false
      try {
        const common = {
          client,
          agent,
          terminal: activeHandle,
          deviceToken: deviceTokenRef.current,
          getConnectionId: getActiveWorktreeConnectionId,
          onUploadStart: () => setIsAttaching(true),
          fitImage: fitMobileAgentImage,
          beforeTerminalSend,
          shouldCancel: () => cancelRequested.current
        }
        const sent =
          source === 'files'
            ? await attachMobileFilesToTerminal({ ...common, pickFiles: picker.pickFiles })
            : source === 'gallery'
              ? await attachMobileGalleryToTerminal({ ...common, pickGallery: picker.pickGallery })
              : await attachMobileImageToTerminal(source, {
                  ...common,
                  pickImage: picker.pickImage
                })
        if (sent) {
          onSuccess()
        }
      } catch (error) {
        if (error instanceof MobileUploadCancelledError) {
          return
        }
        onError()
        if (connState !== 'connected') {
          showToast(
            translate('session.useImageAttachment.disconnected', 'Attach failed (disconnected)'),
            1500
          )
          return
        }
        if (error instanceof ImageLibraryPermissionError) {
          showToast(
            translate('session.useImageAttachment.permissionDenied', 'Photo permission denied'),
            1500
          )
          return
        }
        if (error instanceof MobileFileTooLargeError) {
          showToast(error.message, 1500)
          return
        }
        if (getErrorMessage(error) === 'Clipboard image is too large') {
          showToast(
            translate('session.useImageAttachment.imageTooLarge', 'Image too large to attach'),
            1500
          )
          return
        }
        showToast(translate('session.useImageAttachment.attachFailed', 'Attach failed'), 1500)
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

  return { attachImage, isAttaching, cancelAttach }
}
