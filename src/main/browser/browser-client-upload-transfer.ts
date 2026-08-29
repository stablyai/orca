import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
  BrowserClientFileChannelReadResult,
  decodeBrowserClientFileChannelChunk
} from '../../shared/browser-client-file-channel-protocol'
import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'

export const BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD = 'browser.clientHost.fileChannel.read'

type FileChannelRequest = (method: string, params: unknown) => Promise<unknown>

export type BrowserClientRemoteUploadFile = { remotePath: string; contents: Buffer }

/**
 * Reads the remote workspace files named by a client-placed `browser.upload` command. The paths are
 * interpreted by the runtime against the page's remote workspace; nothing here touches the desktop
 * filesystem, so a malicious remote cannot name a desktop path and have it read.
 */
export async function fetchBrowserClientUploadFiles(options: {
  request: FileChannelRequest
  event: BrowserClientHostCommandEvent
  remotePaths: readonly string[]
}): Promise<BrowserClientRemoteUploadFile[]> {
  if (options.remotePaths.length === 0) {
    throw new Error('browser_client_upload_files_required')
  }
  if (options.remotePaths.length > BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND) {
    throw new Error('browser_client_upload_file_count_exceeded')
  }
  const authority = {
    fileChannelProtocolVersion: BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
    authorityRuntimeId: options.event.authorityRuntimeId,
    authorityEpoch: options.event.authorityEpoch,
    browserHostClientId: options.event.browserHostClientId,
    browserHostGeneration: options.event.browserHostGeneration,
    browserPageId: options.event.browserPageId,
    pageHostGeneration: options.event.pageHostGeneration
  }
  const files: BrowserClientRemoteUploadFile[] = []
  let transferredBytes = 0
  for (const remotePath of options.remotePaths) {
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const parsed = BrowserClientFileChannelReadResult.safeParse(
        await options.request(BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD, {
          ...authority,
          workspaceRelativePath: remotePath,
          offset,
          length: BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
        })
      )
      if (!parsed.success) {
        throw new Error('browser_client_upload_chunk_invalid')
      }
      const chunk = decodeBrowserClientFileChannelChunk(parsed.data.contentBase64)
      if (chunk.byteLength !== parsed.data.bytesRead) {
        throw new Error('browser_client_upload_chunk_invalid')
      }
      transferredBytes += chunk.byteLength
      if (transferredBytes > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
        throw new Error('browser_client_upload_too_large')
      }
      chunks.push(chunk)
      offset += chunk.byteLength
      if (parsed.data.eof) {
        break
      }
      // Why: a host that keeps returning zero bytes without eof would spin this loop forever.
      if (chunk.byteLength === 0) {
        throw new Error('browser_client_upload_transfer_stalled')
      }
    }
    files.push({ remotePath, contents: Buffer.concat(chunks) })
  }
  return files
}

export function readBrowserClientUploadPaths(params: Record<string, unknown>): string[] {
  const files = params.files
  if (!Array.isArray(files)) {
    throw new Error('browser_client_upload_files_required')
  }
  return files.map((file) => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('browser_client_upload_files_required')
    }
    return file
  })
}
