import { IMAGE_AND_PDF_PREVIEW_MIME_TYPES } from '../../../shared/file-preview-kind'
import type { RuntimeFilePreviewResult } from '../../../shared/runtime-types'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcResultExceedsContentBudget
} from '../../../shared/remote-rpc-content-budget'

export const MOBILE_FILE_READ_MAX_BYTES = 512 * 1024

export const LOCAL_PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024

export const PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES = Buffer.byteLength(
  JSON.stringify({
    content: '',
    isBinary: true,
    isImage: true,
    mimeType: 'application/octet-stream'
  }),
  'utf8'
)

export const PREVIEW_CONTENT_FIELDS = ['content'] as const

export function previewableBinaryByteLimit(maxContentBytes: number): number {
  const base64Bytes = Math.max(0, maxContentBytes - PREVIEWABLE_BINARY_EMPTY_RESULT_BYTES)
  return Math.floor(base64Bytes / 4) * 3
}

export function assertPreviewWithinTransportBudget(
  result: RuntimeFilePreviewResult,
  maxContentBytes: number | undefined
): RuntimeFilePreviewResult {
  if (
    maxContentBytes !== undefined &&
    remoteRpcResultExceedsContentBudget(result, maxContentBytes, PREVIEW_CONTENT_FIELDS)
  ) {
    throw new Error('file_too_large')
  }
  return result
}

export const RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES = previewableBinaryByteLimit(
  REMOTE_RPC_MAX_CONTENT_BYTES
)

// One table with local reads and git blobs, so every host previews the same files.
export const RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES = IMAGE_AND_PDF_PREVIEW_MIME_TYPES
