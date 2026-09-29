// Why separate: native-chat's image RPC needs these without pulling in the file-command module graph.
import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'
import { remoteRpcResultExceedsContentBudget } from '../../shared/remote-rpc-content-budget'

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
