import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileChunkResultSchema,
  type MobileWebFileChunkPayload,
  type MobileWebFileChunkResult
} from '../../shared/mobile-web/bridge-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { decodeMobileWebFileBytes } from './mobile-web-file-content'

/** `files.readChunk` answers with content only; the page restates the target it asked for. */
export function decodeMobileWebFileChunk(
  result: unknown,
  payload: MobileWebFileChunkPayload
): MobileWebFileChunkResult {
  const chunk =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  const parsed = MobileWebFileChunkResultSchema.safeParse({
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    offset: payload.offset,
    contentBase64: chunk.contentBase64,
    bytesRead: chunk.bytesRead,
    eof: chunk.eof
  })
  if (!parsed.success || parsed.data.bytesRead > payload.length) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return {
    workspaceId: parsed.data.workspaceId,
    relativePath: parsed.data.relativePath,
    offset: parsed.data.offset,
    bytes: decodeMobileWebFileBytes(parsed.data.contentBase64, MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
    bytesRead: parsed.data.bytesRead,
    eof: parsed.data.eof
  }
}
