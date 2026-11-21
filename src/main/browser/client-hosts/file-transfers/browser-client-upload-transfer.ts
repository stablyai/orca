import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
  BrowserClientFileChannelReadResult,
  decodeBrowserClientFileChannelChunk
} from '../../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserClientPageCommandError } from '../../client-pages/execution/browser-client-page-command-failure'

export const BROWSER_CLIENT_FILE_CHANNEL_READ_METHOD = 'browser.clientHost.fileChannel.read'

type FileChannelRequest = (method: string, params: unknown) => Promise<unknown>

export type BrowserClientRemoteUploadFile = { remotePath: string; contents: Buffer }

// Typed refusals keep their own code; a plain Error collapses to the generic command failure.
export function browserClientUploadTooLargeError(): BrowserClientPageCommandError {
  return new BrowserClientPageCommandError('browser_client_upload_too_large', {
    detail: `upload is limited to ${BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES / (1024 * 1024)} MB in total per command for a page shown on the paired desktop. Upload fewer or smaller files.`
  })
}

export function browserClientUploadFileCountExceededError(): BrowserClientPageCommandError {
  return new BrowserClientPageCommandError('browser_client_upload_file_count_exceeded', {
    detail: `upload is limited to ${BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND} files per command for a page shown on the paired desktop. Split the files across several uploads.`
  })
}

/** Resolve paths through the remote runtime; never read them on the desktop. */
export async function fetchBrowserClientUploadFiles(options: {
  request: FileChannelRequest
  event: BrowserClientHostCommandEvent
  remotePaths: readonly string[]
}): Promise<BrowserClientRemoteUploadFile[]> {
  if (options.remotePaths.length === 0) {
    throw new BrowserClientPageCommandError('browser_client_upload_files_required')
  }
  if (options.remotePaths.length > BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND) {
    throw browserClientUploadFileCountExceededError()
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
        throw new BrowserClientPageCommandError('browser_client_upload_chunk_invalid')
      }
      const chunk = decodeBrowserClientFileChannelChunk(parsed.data.contentBase64)
      if (chunk.byteLength !== parsed.data.bytesRead) {
        throw new BrowserClientPageCommandError('browser_client_upload_chunk_invalid')
      }
      transferredBytes += chunk.byteLength
      if (transferredBytes > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
        throw browserClientUploadTooLargeError()
      }
      chunks.push(chunk)
      offset += chunk.byteLength
      if (parsed.data.eof) {
        break
      }
      // A non-EOF empty chunk would keep this loop running indefinitely.
      if (chunk.byteLength === 0) {
        throw new BrowserClientPageCommandError('browser_client_upload_transfer_stalled')
      }
    }
    files.push({ remotePath, contents: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks) })
  }
  return files
}

export function readBrowserClientUploadPaths(params: Record<string, unknown>): string[] {
  const files = params.files
  if (!Array.isArray(files)) {
    throw new BrowserClientPageCommandError('browser_client_upload_files_required')
  }
  return files.map((file) => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new BrowserClientPageCommandError('browser_client_upload_files_required')
    }
    return file
  })
}
