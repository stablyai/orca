import { z } from 'zod'
import {
  MOBILE_WEB_FILE_CONTENT_MAX_BYTES,
  type MobileWebFileReadPayload,
  type MobileWebFileReadResult
} from '../../shared/mobile-web/file-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

const HostContentSchema = z.object({
  relativePath: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  byteLength: z.number().int().nonnegative()
})

export function projectMobileWebHostFileContent(
  result: unknown,
  payload: MobileWebFileReadPayload
): MobileWebFileReadResult {
  const parsed = HostContentSchema.safeParse(result)
  if (!parsed.success || parsed.data.relativePath !== payload.relativePath) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  const bytes = new TextEncoder().encode(parsed.data.content)
  if (bytes.byteLength > parsed.data.byteLength) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  if (bytes.byteLength > MOBILE_WEB_FILE_CONTENT_MAX_BYTES) {
    throw new MobileWebBridgeClientError('too_large', false)
  }
  return { ...parsed.data, workspaceId: payload.workspaceId }
}
