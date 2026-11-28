/** Upload and download for an SSH host's agent: the files are the host's, so this desktop pulls the named ones from orcad and streams downloads back, never touching a path the host names. */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  DESKTOP_BROWSER_BRIDGE_DOWNLOAD_ABORT_METHOD,
  DESKTOP_BROWSER_BRIDGE_DOWNLOAD_WRITE_METHOD,
  DESKTOP_BROWSER_BRIDGE_FILE_READ_METHOD,
  DesktopBrowserBridgeDownloadWriteResult
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-file-transfer-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
} from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type { RpcResponse } from '../../runtime/rpc/core'
import { BrowserError } from '../browser-error'
import { registerClaimedBrowserDownloadRoute } from '../client-hosts/file-transfers/browser-client-download-routing'
import { sendStagedDownload } from '../client-hosts/file-transfers/browser-client-download-relay'
import { BrowserClientUploadStaging } from '../client-hosts/file-transfers/browser-client-upload-staging'
import {
  fetchBrowserClientUploadFiles,
  readBrowserClientUploadPaths
} from '../client-hosts/file-transfers/browser-client-upload-transfer'
import type { DesktopBrowserBridgeHostChannel } from './desktop-browser-bridge-connection'

type Dispatch = (params: Record<string, unknown>) => Promise<RpcResponse>

const UPLOAD_LIMIT_COPY: Record<string, string> = {
  browser_client_upload_too_large: `Cannot upload more than ${BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES / (1024 * 1024)} MB at once from an SSH host to a desktop tab.`,
  browser_client_upload_file_count_exceeded: `Cannot upload more than ${BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND} files at once from an SSH host to a desktop tab.`
}

export class DesktopBrowserBridgeHostFiles {
  private readonly uploads: BrowserClientUploadStaging
  // Downloads left by an abnormal exit; each live one removes its own directory.
  private readonly downloadsSwept: Promise<unknown>

  constructor(
    private readonly options: {
      /** Owned by this instance: it is swept on creation. */
      stagingRoot: string
      /** Read when a download is saved, so a renamed host shows its current name. */
      hostLabel: () => string
    }
  ) {
    this.uploads = new BrowserClientUploadStaging(path.join(options.stagingRoot, 'uploads'))
    this.downloadsSwept = rm(path.join(options.stagingRoot, 'downloads'), {
      recursive: true,
      force: true
    }).catch(() => undefined)
  }

  /** Runs the local upload on copies of the host files the command named. */
  async upload(
    params: Record<string, unknown>,
    workspaceId: string,
    host: DesktopBrowserBridgeHostChannel,
    dispatch: Dispatch
  ): Promise<RpcResponse> {
    let files: Awaited<ReturnType<typeof fetchBrowserClientUploadFiles>>
    try {
      files = await fetchBrowserClientUploadFiles({
        remotePaths: readBrowserClientUploadPaths(params),
        readChunk: (remotePath, offset, length) =>
          host.request(DESKTOP_BROWSER_BRIDGE_FILE_READ_METHOD, {
            requestId: host.requestId,
            path: remotePath,
            offset,
            length
          })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserError(
        'invalid_argument',
        UPLOAD_LIMIT_COPY[message] ??
          `Cannot read the files to upload from the SSH host: ${message}`
      )
    }
    // Pages own no staging here, so the workspace bounds how many copies Chromium may still read.
    const staged = await this.uploads.stage({
      browserPageId: workspaceId,
      pageHostGeneration: 1,
      files
    })
    files.length = 0
    const release = (): Promise<unknown> =>
      this.uploads.release(staged.stagingId).catch(() => undefined)
    try {
      const response = await dispatch({ ...params, files: [...staged.localFilePaths] })
      // Chromium opens file-input paths lazily, so keep the copies after a successful upload.
      if (!response.ok) {
        await release()
      }
      return response
    } catch (error) {
      await release()
      throw error
    }
  }

  /** Runs the local download into a staging file whose bytes go to the host when it finishes. */
  async download(
    params: Record<string, unknown>,
    host: DesktopBrowserBridgeHostChannel,
    dispatch: Dispatch
  ): Promise<RpcResponse> {
    const { transferId, ...rest } = params
    if (typeof transferId !== 'string' || transferId.length === 0) {
      throw new BrowserError('invalid_argument', 'The SSH host sent a download without a transfer.')
    }
    await this.downloadsSwept
    const directory = path.join(this.options.stagingRoot, 'downloads', randomUUID())
    const stagingPath = path.join(directory, 'download')
    let aborting: Promise<void> | null = null
    const abort = (): Promise<void> => {
      aborting ??= Promise.all([
        rm(directory, { recursive: true, force: true }),
        host.request(DESKTOP_BROWSER_BRIDGE_DOWNLOAD_ABORT_METHOD, { transferId })
      ]).then(
        () => undefined,
        () => undefined
      )
      return aborting
    }
    const unregister = registerClaimedBrowserDownloadRoute({
      transferId,
      browserPageId: typeof rest.page === 'string' ? rest.page : '',
      stagingPath,
      complete: async () => {
        try {
          const savedPath = await sendStagedDownload(
            stagingPath,
            () => {
              if (aborting) {
                throw new Error('browser_client_download_canceled')
              }
            },
            async (chunk) => {
              const parsed = DesktopBrowserBridgeDownloadWriteResult.safeParse(
                await host.request(DESKTOP_BROWSER_BRIDGE_DOWNLOAD_WRITE_METHOD, {
                  transferId,
                  ...chunk
                })
              )
              if (!parsed.success) {
                throw new Error('browser_client_download_chunk_rejected')
              }
              return parsed.data.path ?? null
            }
          )
          return { workspaceRelativePath: savedPath, hostLabel: this.options.hostLabel() }
        } catch (error) {
          await abort()
          throw error
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        }
      },
      abort
    })
    try {
      return await dispatch({ ...rest, path: stagingPath })
    } finally {
      // Taken once the download starts; otherwise nothing will ever use the staging path.
      if (unregister()) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}
