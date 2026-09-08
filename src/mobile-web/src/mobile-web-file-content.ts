import {
  MOBILE_WEB_FILE_CONTENT_MAX_BYTES,
  type MobileWebFileReadResult,
  type MobileWebFileReadWireResult
} from '../../shared/mobile-web/bridge-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export function decodeMobileWebFileContent(
  result: MobileWebFileReadWireResult
): MobileWebFileReadResult {
  const bytes = decodeMobileWebFileBytes(result.contentBase64, MOBILE_WEB_FILE_CONTENT_MAX_BYTES)
  return {
    workspaceId: result.workspaceId,
    relativePath: result.relativePath,
    content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
    truncated: result.truncated,
    byteLength: result.byteLength
  }
}

export function decodeMobileWebFileBytes(value: string, maximum: number): Uint8Array {
  const binary = atob(value)
  if (binary.length > maximum) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
