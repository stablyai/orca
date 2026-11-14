import { isWindowsAbsolutePathLike } from '../../../../src/shared/cross-platform-path'
import { formatImageDropPasteText } from '../../../../src/shared/image-path-paste'
import { formatAgentImagePath } from '../../../../src/shared/agent-image-paste'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from './mobile-clipboard-image-upload-chunk'
import '../../transport/connection/stable-logical-rpc-client'
import { isLogicalClientCutoverError } from '../../transport/connection/logical-client-cutover-error'
import {
  clipboardImageSaveAsTempFile,
  clipboardImageUploadAbort,
  clipboardImageUploadAppend,
  clipboardImageUploadCommit,
  clipboardImageUploadStart,
  type MobileClipboardImageRpcSender
} from './mobile-clipboard-image-operations'

export const MOBILE_CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024

export const MOBILE_CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
const MOBILE_CLIPBOARD_IMAGE_UPLOAD_CUTOVER_MAX_RETRIES = 1

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

export async function saveMobileClipboardImageAsTempFile(
  client: MobileClipboardImageRpcSender,
  imageData: string,
  args?: { connectionId?: string | null; fileName?: string }
): Promise<string> {
  const contentBase64 = normalizeMobileClipboardImageBase64(imageData)
  const connectionId = args?.connectionId ?? null
  for (let retry = 0; ; retry += 1) {
    try {
      return await uploadMobileClipboardImageTransaction(
        client,
        contentBase64,
        connectionId,
        args?.fileName
      )
    } catch (error) {
      if (
        !isLogicalClientCutoverError(error) ||
        retry >= MOBILE_CLIPBOARD_IMAGE_UPLOAD_CUTOVER_MAX_RETRIES
      ) {
        throw error
      }
      // Why: upload replay can create only temp state; terminal input is sent after this returns.
    }
  }
}

async function uploadMobileClipboardImageTransaction(
  client: MobileClipboardImageRpcSender,
  contentBase64: string,
  connectionId: string | null,
  fileName?: string
): Promise<string> {
  const startResponse = await clipboardImageUploadStart.request(client, {
    expectedBase64Length: contentBase64.length,
    connectionId,
    // Image uploads keep the exact request shape older hosts and recordings expect.
    ...(fileName ? { fileName } : {})
  })

  // Read method_not_found before interpretation to allow a small image’s legacy single-frame fallback.
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= MOBILE_CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return clipboardImageSaveAsTempFile.interpret(
        await clipboardImageSaveAsTempFile.request(client, { contentBase64, connectionId })
      )
    }
    throw new Error(startResponse.error.message)
  }

  const { uploadId } = clipboardImageUploadStart.interpret(startResponse)
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      clipboardImageUploadAppend.interpret(
        await clipboardImageUploadAppend.request(client, {
          uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        })
      )
    }
    return clipboardImageUploadCommit.interpret(
      await clipboardImageUploadCommit.request(client, { uploadId })
    )
  } catch (error) {
    // Why: failed mobile image sends create server-side upload state; abort so
    // the bounded upload slot is released immediately instead of waiting for TTL.
    await clipboardImageUploadAbort.request(client, { uploadId }).catch(() => {})
    throw error
  }
}

export function buildMobileImagePastePayload(filePath: string, agent?: string | null): string {
  // Why: generated image paths are paste payloads, not ordinary typed input.
  // Bracket the path even when it is one line so agents receive it atomically
  // and stale terminal paste state cannot turn it into shell commands.
  return bracketMobileImagePaste(formatAgentImagePath(agent, filePath))
}

// Match desktop terminal paste when no agent identity is available yet.
export function buildMobileTerminalImagePastePayload(
  filePath: string,
  agent?: string | null
): string {
  const id = agent?.trim()
  if (!id || id === 'unknown' || id === 'codex') {
    const pasted = formatImageDropPasteText(
      filePath,
      isWindowsAbsolutePathLike(filePath) ? 'windows' : 'posix'
    )
    return bracketMobileImagePaste(pasted ?? filePath)
  }
  return buildMobileImagePastePayload(filePath, id)
}

function bracketMobileImagePaste(pasted: string): string {
  return `\x1b[200~${pasted.split('\x1b').join('\u241b')}\x1b[201~`
}
