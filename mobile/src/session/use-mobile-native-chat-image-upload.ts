import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import {
  ImageLibraryPermissionError,
  pickMobileImages,
  type MobileImageSource
} from './mobile-image-source-picker'
import {
  uploadMobileNativeChatImages,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'

type CurrentRef<T> = { readonly current: T }
type UploadedNativeChatImage = Omit<PendingNativeChatImage, 'id'>
type ShowToast = (message: string, durationMs?: number) => void

export function useMobileNativeChatImageUpload(args: {
  client: RpcClient | null
  activeHandleRef: CurrentRef<string | null>
  getActiveWorktreeConnectionId: () => Promise<string | null>
  connState: ConnectionState
  scopeKey: string | null
  structuredNativeChat: boolean
  /** Hosted page: uploads go through the desktop's native-chat adapter, not the RPC client. */
  operations: HostSessionNativeChatOperations | null
  targetRef: CurrentRef<HostSessionNativeChatTarget | null>
  showToast: ShowToast
  onImagesUploaded: (scope: string, images: UploadedNativeChatImage[]) => void
  onAttachSuccess?: () => void
  onError?: () => void
}): {
  attachImage: (source: MobileImageSource) => Promise<void>
  isAttaching: boolean
} {
  const {
    activeHandleRef,
    client,
    connState,
    getActiveWorktreeConnectionId,
    onAttachSuccess,
    onError,
    onImagesUploaded,
    operations,
    scopeKey,
    showToast,
    structuredNativeChat,
    targetRef
  } = args
  const [isAttaching, setIsAttaching] = useState(false)
  const attachingCount = useRef(0)
  const connStateRef = useRef(connState)
  useLayoutEffect(() => {
    connStateRef.current = connState
  }, [connState])

  const attachImage = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      const scope = scopeKey
      const target = targetRef.current
      if (
        !scope ||
        connState !== 'connected' ||
        (!activeHandleRef.current && !structuredNativeChat) ||
        (!client && (!operations?.attachImage || !target))
      ) {
        return
      }
      let started = false
      const uploadedImages: UploadedNativeChatImage[] = []
      let uploadError: unknown = null
      const onUploadStart = (): void => {
        started = true
        attachingCount.current += 1
        setIsAttaching(true)
      }
      try {
        if (client) {
          await uploadMobileNativeChatImages(source, {
            client,
            getConnectionId: getActiveWorktreeConnectionId,
            pickImages: pickMobileImages,
            onImageUploaded: (image) => uploadedImages.push(image),
            onUploadStart
          })
        } else {
          onUploadStart()
          const result = await operations!.attachImage!(target!, source)
          if (result.status === 'permission-denied') {
            throw new ImageLibraryPermissionError()
          }
          if (result.status === 'too-large') {
            throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
          }
          if (result.status === 'accepted') {
            uploadedImages.push({
              path: result.attachment.reference,
              previewUri: result.attachment.previewUri
            })
          }
        }
      } catch (error) {
        uploadError = error
      } finally {
        if (started) {
          attachingCount.current -= 1
          if (attachingCount.current === 0) {
            setIsAttaching(false)
          }
        }
      }
      if (uploadedImages.length > 0) {
        onImagesUploaded(scope, uploadedImages)
        onAttachSuccess?.()
      }
      if (uploadError !== null) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError)
        onError?.()
        if (connStateRef.current !== 'connected') {
          showToast('Attach failed (disconnected)', 1500)
          return
        }
        if (uploadError instanceof ImageLibraryPermissionError) {
          showToast('Photo permission denied', 1500)
          return
        }
        if (message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR) {
          showToast('Image too large to attach', 1500)
          return
        }
        showToast('Attach failed', 1500)
      }
    },
    [
      activeHandleRef,
      client,
      connState,
      getActiveWorktreeConnectionId,
      onAttachSuccess,
      onError,
      onImagesUploaded,
      operations,
      scopeKey,
      showToast,
      structuredNativeChat,
      targetRef
    ]
  )

  return { attachImage, isAttaching }
}
