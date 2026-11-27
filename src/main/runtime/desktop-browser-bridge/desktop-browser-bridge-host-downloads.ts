/** `download --path` on a desktop tab: the desktop streams the file back and this host saves it at the path, which the desktop never learns. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { BrowserError } from '../../browser/browser-error'
import {
  durableWriteTempPath,
  writeFileDurableIfCurrent
} from '../../filesystem/durable-file-write'
import { BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES } from '../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type {
  DesktopBrowserBridgeDownloadAbortParams,
  DesktopBrowserBridgeDownloadWriteParams
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-file-transfer-protocol'

// Each holds up to the transfer cap in memory until its final write.
const MAX_DOWNLOADS_PER_ATTACHMENT = 4

type ExpectedDownload = {
  attachmentId: string
  savePath: string
  chunks: Buffer[]
  received: number
  /** Why saving failed, for a command still waiting on it. */
  failure: string | null
}

export class DesktopBrowserBridgeHostDownloads {
  private readonly downloads = new Map<string, ExpectedDownload>()

  /** Forwards the command with a transfer id the desktop streams the file back under. */
  async forward(
    attachmentId: string,
    savePath: string,
    forwardCommand: (transferId: string) => Promise<unknown>
  ): Promise<{ path: string }> {
    let waiting = 0
    for (const download of this.downloads.values()) {
      waiting += download.attachmentId === attachmentId ? 1 : 0
    }
    if (waiting >= MAX_DOWNLOADS_PER_ATTACHMENT) {
      throw new BrowserError(
        'browser_download_busy',
        'Too many downloads from this host are still in progress on the desktop.'
      )
    }
    const transferId = randomUUID()
    const download: ExpectedDownload = {
      attachmentId,
      savePath,
      chunks: [],
      received: 0,
      failure: null
    }
    this.downloads.set(transferId, download)
    try {
      await forwardCommand(transferId)
    } catch (error) {
      const code = error instanceof BrowserError ? error.code : null
      // The desktop keeps downloading and still streams the file here when it finishes.
      if (code === 'browser_download_in_progress') {
        throw new BrowserError(
          code,
          `The download is still in progress and will be saved to ${savePath}.`
        )
      }
      this.forget(transferId, download)
      if (code === 'browser_download_failed' && download.failure) {
        throw new BrowserError(code, download.failure)
      }
      throw error
    }
    this.forget(transferId, download)
    return { path: savePath }
  }

  /** The final write is acknowledged only once the file is saved, so the desktop reports it truthfully. */
  async write(chunk: DesktopBrowserBridgeDownloadWriteParams): Promise<{ path?: string }> {
    const download = this.downloads.get(chunk.transferId)
    if (!download || download.attachmentId !== chunk.attachmentId) {
      throw new Error('desktop_browser_bridge_download_unknown')
    }
    if (chunk.offset !== download.received) {
      this.fail(chunk.transferId, download, 'the download stream broke.')
      throw new Error('desktop_browser_bridge_download_out_of_order')
    }
    const bytes = Buffer.from(chunk.contentBase64, 'base64')
    download.received += bytes.byteLength
    if (download.received > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
      this.fail(chunk.transferId, download, 'the file is larger than 64 MB.')
      throw new Error('desktop_browser_bridge_download_too_large')
    }
    download.chunks.push(bytes)
    if (!chunk.final) {
      return {}
    }
    const contents = Buffer.concat(download.chunks)
    download.chunks = []
    // Committed just before the rename, so an abort from then on finds nothing to cancel.
    let committed = false
    const commit = (): boolean => {
      if (!committed && this.downloads.get(chunk.transferId) === download) {
        committed = true
        this.forget(chunk.transferId, download)
      }
      return committed
    }
    try {
      await mkdir(path.dirname(download.savePath), { recursive: true })
      // Through a temp file, so a failed save leaves any earlier file at the path intact.
      const saved = await writeFileDurableIfCurrent(
        durableWriteTempPath(download.savePath),
        download.savePath,
        contents,
        commit
      )
      if (!saved) {
        throw new Error('desktop_browser_bridge_download_unknown')
      }
    } catch (error) {
      this.fail(
        chunk.transferId,
        download,
        `Could not save the download to ${download.savePath}: ${String(error)}`
      )
      throw error
    }
    this.forget(chunk.transferId, download)
    return { path: download.savePath }
  }

  abort(params: DesktopBrowserBridgeDownloadAbortParams): boolean {
    const download = this.downloads.get(params.transferId)
    if (!download || download.attachmentId !== params.attachmentId) {
      return false
    }
    this.forget(params.transferId, download)
    return true
  }

  detach(attachmentId: string): void {
    for (const [transferId, download] of this.downloads) {
      if (download.attachmentId === attachmentId) {
        this.downloads.delete(transferId)
      }
    }
  }

  // The waiting command still holds the record, so it can read why.
  private fail(transferId: string, download: ExpectedDownload, failure: string): void {
    download.failure = failure
    download.chunks = []
    this.forget(transferId, download)
  }

  private forget(transferId: string, download: ExpectedDownload): void {
    if (this.downloads.get(transferId) === download) {
      this.downloads.delete(transferId)
    }
  }
}
