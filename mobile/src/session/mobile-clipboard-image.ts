import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

export const MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const MOBILE_CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function normalizeMobileClipboardImageBase64(data: string): string {
  const contentBase64 = data.replace(DATA_URL_PREFIX_RE, '')
  if (contentBase64.length > MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS) {
    throw new Error('Clipboard image is too large')
  }
  if (contentBase64.length % 4 === 1 || !BASE64_PATTERN.test(contentBase64)) {
    throw new Error('Clipboard image content must be base64')
  }
  return contentBase64
}

function assertSuccess<T>(response: RpcSuccess | RpcFailure): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}

export async function saveMobileClipboardImageAsTempFile(
  client: Pick<RpcClient, 'sendRequest'>,
  imageData: string,
  args?: { connectionId?: string | null }
): Promise<string> {
  const contentBase64 = normalizeMobileClipboardImageBase64(imageData)
  const connectionId = args?.connectionId ?? null
  const startResponse = await client.sendRequest('clipboard.startImageUpload', {
    expectedBase64Length: contentBase64.length,
    connectionId
  })

  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= MOBILE_CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return assertSuccess<string>(
        await client.sendRequest('clipboard.saveImageAsTempFile', { contentBase64, connectionId })
      )
    }
    throw new Error(startResponse.error.message)
  }

  const { uploadId } = startResponse.result as { uploadId: string }
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      assertSuccess(
        await client.sendRequest('clipboard.appendImageUploadChunk', {
          uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        })
      )
    }
    return assertSuccess<string>(
      await client.sendRequest('clipboard.commitImageUpload', { uploadId })
    )
  } catch (error) {
    // Why: failed mobile image sends create server-side upload state; abort so
    // the bounded upload slot is released immediately instead of waiting for TTL.
    await client.sendRequest('clipboard.abortImageUpload', { uploadId }).catch(() => {})
    throw error
  }
}

export function buildMobileImagePastePayload(filePath: string): string {
  // Why: generated image paths are paste payloads, not ordinary typed input.
  // Bracket the path even when it is one line so agents receive it atomically
  // and stale terminal paste state cannot turn it into shell commands.
  return `\x1b[200~${filePath.split('\x1b').join('\u241b')}\x1b[201~`
}
