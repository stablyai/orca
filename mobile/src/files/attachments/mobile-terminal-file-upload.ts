import {
  MOBILE_PICKED_FILE_MAX_BYTES,
  MobileFileTooLargeError,
  MobileUploadCancelledError,
  type PickedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import { saveMobileClipboardImageAsTempFile } from './mobile-clipboard-image'
import type { MobileClipboardImageRpcSender } from './mobile-clipboard-image-operations'
import { uploadMobileAgentSessionAttachment } from './mobile-agent-session-attachment-upload'

type TerminalFileUploadClient = MobileClipboardImageRpcSender &
  Parameters<typeof uploadMobileAgentSessionAttachment>[0]

async function joinedBase64(file: PickedMobileFile, shouldCancel?: () => boolean): Promise<string> {
  let base64 = ''
  for await (const chunk of file.chunks()) {
    if (shouldCancel?.()) {
      throw new MobileUploadCancelledError()
    }
    base64 += chunk
  }
  return base64
}

// Only the final slice carries padding, so slices join into one valid base64 string.
async function uploadThroughClipboardRpc(
  client: MobileClipboardImageRpcSender,
  file: PickedMobileFile,
  connectionId: string | null,
  shouldCancel?: () => boolean
): Promise<string> {
  if (file.byteLength > MOBILE_PICKED_FILE_MAX_BYTES) {
    throw new MobileFileTooLargeError(file.name, MOBILE_PICKED_FILE_MAX_BYTES)
  }
  if (shouldCancel?.()) {
    throw new MobileUploadCancelledError()
  }
  const base64 = await joinedBase64(file, shouldCancel)
  if (shouldCancel?.()) {
    throw new MobileUploadCancelledError()
  }
  return saveMobileClipboardImageAsTempFile(client, base64, {
    connectionId,
    ...(file.generatedName ? {} : { fileName: file.name })
  })
}

/** The host path of a file headed to a terminal. A local host stores it by streamed chunks, so it may be as large as a chat upload; a remote or older host takes it whole through the clipboard transfer. */
export async function uploadMobileTerminalFile(
  client: TerminalFileUploadClient,
  file: PickedMobileFile,
  options: {
    connectionId: string | null
    onProgress?: (sentBytes: number) => void
    shouldCancel?: () => boolean
  }
): Promise<string> {
  try {
    if (options.connectionId !== null) {
      // The file must exist on the remote machine the terminal runs on, not on this host.
      return await uploadThroughClipboardRpc(
        client,
        file,
        options.connectionId,
        options.shouldCancel
      )
    }
    const stored = await uploadMobileAgentSessionAttachment(client, {
      name: file.name,
      byteLength: file.byteLength,
      chunks: file.chunks(),
      onProgress: options.onProgress,
      shouldCancel: options.shouldCancel
    })
    return stored.path
  } catch (error) {
    if (
      error instanceof MobileFileTooLargeError ||
      error instanceof MobileUploadCancelledError ||
      options.connectionId !== null
    ) {
      throw error
    }
    // A host that predates streamed terminal uploads refuses the request; small files still go the old way.
    return uploadThroughClipboardRpc(client, file, null, options.shouldCancel)
  }
}
