import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  type MobileNativeChatDraftDestination
} from '../drafts/mobile-native-chat-draft-inputs'
import { createNonSecureContextUuid as createUuidV4 } from '../../../../../../src/shared/identifiers/non-secure-context-uuid'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { translate } from '../../../../i18n/mobile-i18n'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../../../../src/shared/clipboard/clipboard-image'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../../transport/connection/connection-state'
import { useMediaPicker } from '../../../../platform/media-picking/media-picker'
import {
  ImageLibraryPermissionError,
  MobileFileTooLargeError,
  MobileUploadCancelledError,
  type PickedMobileFile
} from '../../../../platform/media-picking/media-picker-contract'
import { uploadMobileTerminalFile } from '../../../../files/attachments/mobile-terminal-file-upload'
import {
  uploadMobileNativeChatImages,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'
import {
  readMobilePastedImages,
  type MobileNativeChatImageSource
} from './mobile-native-chat-composer-paste'
import { useClipboardReader } from '../../../../platform/clipboard/clipboard'
import { fitMobileAgentImage } from '../../../../files/attachments/mobile-agent-image-fit'

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
  onImagesUploaded: (
    scope: MobileNativeChatDraftDestination,
    images: UploadedNativeChatImage[]
  ) => void
  onAttachSuccess?: () => void
  onError?: () => void
}): {
  attachImage: (source: MobileNativeChatImageSource) => Promise<void>
  /** Files of any type and size for a terminal-backed chat; they ride the next send as paths. */
  attachStreamedFiles: (
    files: AsyncIterable<PickedMobileFile> | readonly PickedMobileFile[]
  ) => Promise<void>
  attachFiles: () => Promise<void>
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
  const picker = useMediaPicker()
  const clipboard = useClipboardReader()
  const attachingCount = useRef(0)
  const connStateRef = useRef(connState)
  useLayoutEffect(() => {
    connStateRef.current = connState
  }, [connState])

  const attachImage = useCallback(
    async (source: MobileNativeChatImageSource): Promise<void> => {
      const scope = scopeKey
      if (
        !client ||
        !scope ||
        connState !== 'connected' ||
        (!activeHandleRef.current && !structuredNativeChat)
      ) {
        return
      }
      const destination = mobileNativeChatDraftDestination(scope)
      updateMobileNativeChatDraftInputs(destination, (inputs) => ({
        ...inputs,
        pending: (inputs.pending ?? 0) + 1
      }))
      let started = false
      const uploadedImages: UploadedNativeChatImage[] = []
      let uploadError: unknown = null
      try {
        await uploadMobileNativeChatImages(source, {
          canContinue: () => destination.active,
          client,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImages: (from) =>
            typeof from === 'string'
              ? picker.pickImages(from)
              : 'prepared' in from
                ? from.prepared
                : readMobilePastedImages(from, clipboard),
          onImageUploaded: (image) => uploadedImages.push(image),
          onUploadStart: () => {
            started = true
            attachingCount.current += 1
            setIsAttaching(true)
          },
          fitImage: fitMobileAgentImage
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
        onImagesUploaded(destination, uploadedImages)
        onAttachSuccess?.()
      }
      updateMobileNativeChatDraftInputs(destination, (inputs) => ({
        ...inputs,
        pending: Math.max(0, (inputs.pending ?? 0) - 1)
      }))
      if (uploadError !== null && destination.active) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError)
        onError?.()
        if (connStateRef.current !== 'connected') {
          showToast(
            translate('chat.useImageUpload.disconnected', 'Attach failed (disconnected)'),
            1500
          )
          return
        }
        if (uploadError instanceof ImageLibraryPermissionError) {
          showToast(
            translate('chat.useImageUpload.permissionDenied', 'Photo permission denied'),
            1500
          )
          return
        }
        if (message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR) {
          showToast(
            translate('chat.useImageUpload.imageTooLarge', 'Image too large to attach'),
            1500
          )
          return
        }
        showToast(translate('chat.useImageUpload.attachFailed', 'Attach failed'), 1500)
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
      clipboard,
      picker,
      scopeKey,
      showToast,
      structuredNativeChat
    ]
  )

  const attachStreamedFiles = useCallback(
    async (
      source: AsyncIterable<PickedMobileFile> | readonly PickedMobileFile[]
    ): Promise<void> => {
      const staged = Array.isArray(source) ? [...source] : []
      const scope = scopeKey
      if (
        !client ||
        !scope ||
        connState !== 'connected' ||
        (!activeHandleRef.current && !structuredNativeChat)
      ) {
        staged.forEach((file) => file.dispose?.())
        return
      }
      const destination = mobileNativeChatDraftDestination(scope)
      updateMobileNativeChatDraftInputs(destination, (inputs) => ({
        ...inputs,
        pending: (inputs.pending ?? 0) + 1
      }))
      const uploaded: UploadedNativeChatImage[] = []
      let failure: unknown = null
      let started = false
      try {
        const connectionId = await getActiveWorktreeConnectionId()
        for await (const file of source) {
          if (!destination.active) {
            file.dispose?.()
            break
          }
          if (!started) {
            started = true
            attachingCount.current += 1
            setIsAttaching(true)
          }
          const uploadId = createUuidV4()
          // A removed chip must stay removed, so progress only updates a chip that is still there.
          const setUpload = (sentBytes: number | null, add = false): void =>
            updateMobileNativeChatDraftInputs(destination, (inputs) => {
              const { [uploadId]: current, ...rest } = inputs.uploads ?? {}
              if (sentBytes === null || (!add && current === undefined)) {
                return { ...inputs, uploads: rest }
              }
              const upload = { name: file.name, mime: file.mime, byteLength: file.byteLength }
              return { ...inputs, uploads: { ...rest, [uploadId]: { ...upload, sentBytes } } }
            })
          setUpload(0, true)
          try {
            const path = await uploadMobileTerminalFile(client, file, {
              connectionId,
              onProgress: (sentBytes) => setUpload(sentBytes),
              shouldCancel: () =>
                !destination.active ||
                readMobileNativeChatDraftInputs(destination.scope).uploads?.[uploadId] === undefined
            })
            uploaded.push({ path, previewUri: path })
          } catch (error) {
            // A removed chip skips just that file; any other failure stops the batch.
            if (!(error instanceof MobileUploadCancelledError)) {
              throw error
            }
          } finally {
            setUpload(null)
            file.dispose?.()
          }
        }
      } catch (error) {
        failure = error
      } finally {
        staged.forEach((file) => file.dispose?.())
        if (started) {
          attachingCount.current -= 1
          if (attachingCount.current === 0) {
            setIsAttaching(false)
          }
        }
      }
      if (uploaded.length > 0) {
        onImagesUploaded(destination, uploaded)
        onAttachSuccess?.()
      }
      updateMobileNativeChatDraftInputs(destination, (inputs) => ({
        ...inputs,
        pending: Math.max(0, (inputs.pending ?? 0) - 1)
      }))
      if (failure !== null && destination.active) {
        onError?.()
        showToast(
          failure instanceof MobileFileTooLargeError
            ? failure.message
            : connStateRef.current !== 'connected'
              ? translate('chat.useImageUpload.disconnected', 'Attach failed (disconnected)')
              : translate('chat.useImageUpload.attachFailed', 'Attach failed'),
          1500
        )
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
  const attachFiles = useCallback(
    () => attachStreamedFiles(picker.pickFiles()),
    [attachStreamedFiles, picker]
  )

  return { attachImage, attachStreamedFiles, attachFiles, isAttaching }
}
