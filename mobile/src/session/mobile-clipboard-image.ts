import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

export const MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const MOBILE_CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
// Why: PNG bytes don't scale exactly with pixel area, so undershoot the target on
// each pass and let the bounded retry below converge instead of distorting in one shot.
const MOBILE_CLIPBOARD_IMAGE_DOWNSCALE_SAFETY = 0.85
const MOBILE_CLIPBOARD_IMAGE_MAX_DOWNSCALE_ATTEMPTS = 3

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

export type MobileClipboardImage = {
  data: string
  size: { width: number; height: number }
}

export type MobileClipboardImageResizer = (
  source: string,
  target: { width: number; height: number }
) => Promise<{ data: string; width: number; height: number }>

/**
 * Returns the pixel dimensions to resize a clipboard image to so its base64 fits
 * the upload budget, or null when it already fits (or its dimensions are unusable).
 */
export function computeMobileClipboardImageDownscale(
  base64Length: number,
  width: number,
  height: number,
  maxBase64Length: number
): { width: number; height: number } | null {
  if (base64Length <= maxBase64Length) {
    return null
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const scale = Math.sqrt(maxBase64Length / base64Length) * MOBILE_CLIPBOARD_IMAGE_DOWNSCALE_SAFETY
  const nextWidth = Math.max(1, Math.floor(width * scale))
  const nextHeight = Math.max(1, Math.floor(height * scale))
  // Guard against a no-op shrink (already 1px) so the retry loop can't spin forever.
  if (nextWidth >= width && nextHeight >= height) {
    return null
  }
  return { width: nextWidth, height: nextHeight }
}

/**
 * Downscales an oversized clipboard image until its base64 fits the upload budget,
 * delegating the actual raster resize to the injected `resize`. Returns the
 * upload-ready base64; if it still overflows after the bounded retries the
 * downstream size check rejects it with the same "too large" error as before.
 */
export async function prepareMobileClipboardImageBase64(
  image: MobileClipboardImage,
  resize: MobileClipboardImageResizer,
  maxBase64Length: number = MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS
): Promise<string> {
  let data = image.data
  let width = image.size.width
  let height = image.size.height
  for (let attempt = 0; attempt < MOBILE_CLIPBOARD_IMAGE_MAX_DOWNSCALE_ATTEMPTS; attempt += 1) {
    const contentLength = data.replace(DATA_URL_PREFIX_RE, '').length
    const target = computeMobileClipboardImageDownscale(
      contentLength,
      width,
      height,
      maxBase64Length
    )
    if (!target) {
      return data
    }
    const resized = await resize(data, target)
    data = resized.data
    width = resized.width
    height = resized.height
  }
  return data
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
