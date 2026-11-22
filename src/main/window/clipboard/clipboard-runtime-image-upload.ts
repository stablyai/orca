import { assertClipboardImageByteLengthWithinLimit } from '../../../shared/clipboard/clipboard-image'
import {
  appendClipboardImageUploadChunks,
  type ClipboardImageUploadSlot
} from '../../../shared/clipboard/clipboard-image-chunk-upload'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'

const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000

async function callRuntimeClipboardMethod<TResult>(
  userDataPath: string,
  runtimeEnvironmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    runtimeEnvironmentId,
    method,
    params,
    CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

async function saveClipboardImageBase64InRuntime(
  userDataPath: string,
  runtimeEnvironmentId: string,
  contentBase64: string,
  connectionId: string | null
): Promise<string> {
  const startResponse = await callRuntimeEnvironment(
    userDataPath,
    runtimeEnvironmentId,
    'clipboard.startImageUpload',
    { expectedBase64Length: contentBase64.length, connectionId },
    CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
  )
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return callRuntimeClipboardMethod<string>(
        userDataPath,
        runtimeEnvironmentId,
        'clipboard.saveImageAsTempFile',
        { contentBase64, connectionId }
      )
    }
    throw new Error(startResponse.error.message)
  }
  const result = startResponse.result
  if (
    !result ||
    typeof result !== 'object' ||
    !('uploadId' in result) ||
    typeof result.uploadId !== 'string'
  ) {
    throw new Error('Remote clipboard image upload returned an invalid id')
  }
  const slot: ClipboardImageUploadSlot = {
    uploadId: result.uploadId,
    acceptsOutOfOrderChunks:
      'acceptsOutOfOrderChunks' in result && result.acceptsOutOfOrderChunks === true
  }
  const { uploadId } = slot
  try {
    await appendClipboardImageUploadChunks(slot, contentBase64, (chunk) =>
      callRuntimeClipboardMethod(
        userDataPath,
        runtimeEnvironmentId,
        'clipboard.appendImageUploadChunk',
        chunk
      )
    )
    const remotePath = await callRuntimeClipboardMethod<string>(
      userDataPath,
      runtimeEnvironmentId,
      'clipboard.commitImageUpload',
      { uploadId }
    )
    if (typeof remotePath !== 'string') {
      throw new Error('Remote clipboard image save returned an invalid path')
    }
    return remotePath
  } catch (error) {
    // Release failed chunked-upload slots immediately rather than wait for TTL cleanup.
    await callRuntimeClipboardMethod(
      userDataPath,
      runtimeEnvironmentId,
      'clipboard.abortImageUpload',
      {
        uploadId
      }
    ).catch(() => {})
    throw error
  }
}

// connectionId belongs to the runtime's SSH registry; null targets the runtime host itself.
export function saveClipboardImageBufferInRuntime(
  userDataPath: string,
  runtimeEnvironmentId: string,
  buffer: Buffer,
  connectionId: string | null = null
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  return saveClipboardImageBase64InRuntime(
    userDataPath,
    runtimeEnvironmentId,
    buffer.toString('base64'),
    connectionId
  )
}
