import {
  cursorSidecarScanRequestSchema,
  cursorSidecarScanResponseSchema,
  type CursorSidecarScanRequest,
  type CursorSidecarScanResponse
} from '../../shared/cursor-sidecar-scan'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

const CURSOR_SIDECAR_SCAN_TIMEOUT_MS = 45_000

export async function scanSshCursorSidecars(
  mux: SshChannelMultiplexer,
  request: CursorSidecarScanRequest,
  options?: { signal?: AbortSignal }
): Promise<CursorSidecarScanResponse> {
  const validatedRequest = cursorSidecarScanRequestSchema.parse(request)
  try {
    const result = await mux.request('fs.scanCursorSidecars', validatedRequest, {
      signal: options?.signal,
      timeoutMs: CURSOR_SIDECAR_SCAN_TIMEOUT_MS
    })
    return cursorSidecarScanResponseSchema.parse(result)
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new Error('remote_cursor_sidecar_scan_unavailable')
    }
    throw error
  }
}
