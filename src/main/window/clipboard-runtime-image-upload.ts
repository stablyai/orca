import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
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
  contentBase64: string
): Promise<string> {
  const startResponse = await callRuntimeEnvironment(
    userDataPath,
    runtimeEnvironmentId,
    'clipboard.startImageUpload',
    { expectedBase64Length: contentBase64.length, connectionId: null },
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
        { contentBase64, connectionId: null }
      )
    }
    throw new Error(startResponse.error.message)
  }
  const result = startResponse.result
  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as { uploadId?: unknown }).uploadId !== 'string'
  ) {
    throw new Error('Remote clipboard image upload returned an invalid id')
  }
  const { uploadId } = result as { uploadId: string }
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await callRuntimeClipboardMethod(
        userDataPath,
        runtimeEnvironmentId,
        'clipboard.appendImageUploadChunk',
        {
          uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        }
      )
    }
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
    // Why: failed chunked pastes should release the remote upload slot
    // immediately instead of waiting for TTL cleanup.
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

export function saveClipboardImageBufferInRuntime(
  userDataPath: string,
  runtimeEnvironmentId: string,
  buffer: Buffer
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  return saveClipboardImageBase64InRuntime(
    userDataPath,
    runtimeEnvironmentId,
    buffer.toString('base64')
  )
}
