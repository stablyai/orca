import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  type MobileWebFileChunkResult,
  type MobileWebFileChunkWireResult
} from '../../shared/mobile-web/bridge-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { decodeMobileWebFileBytes } from './mobile-web-file-content'

export function decodeMobileWebFileChunk(
  result: MobileWebFileChunkWireResult
): MobileWebFileChunkResult {
  const bytes = decodeMobileWebFileBytes(result.contentBase64, MOBILE_WEB_FILE_CHUNK_MAX_BYTES)
  if (bytes.byteLength !== result.bytesRead) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return {
    workspaceId: result.workspaceId,
    relativePath: result.relativePath,
    offset: result.offset,
    bytes,
    bytesRead: result.bytesRead,
    eof: result.eof
  }
}
