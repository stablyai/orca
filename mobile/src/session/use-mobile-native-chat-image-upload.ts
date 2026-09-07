import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
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
    scopeKey,
    showToast,
    structuredNativeChat
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
      if (
        !client ||
        !scope ||
        connState !== 'connected' ||
        (!activeHandleRef.current && !structuredNativeChat)
      ) {
        return
      }
      let started = false
      const uploadedImages: UploadedNativeChatImage[] = []
      let uploadError: unknown = null
      try {
        await uploadMobileNativeChatImages(source, {
          client,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImages: pickMobileImages,
          onImageUploaded: (image) => uploadedImages.push(image),
          onUploadStart: () => {
            started = true
            attachingCount.current += 1
            setIsAttaching(true)
          }
        })
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
      scopeKey,
      showToast,
      structuredNativeChat
    ]
  )

  return { attachImage, isAttaching }
}
