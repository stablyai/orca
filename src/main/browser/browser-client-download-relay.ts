import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
  BrowserClientFileChannelWriteResult
} from '../../shared/browser-client-file-channel-protocol'
import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

export const BROWSER_CLIENT_FILE_CHANNEL_WRITE_METHOD = 'browser.clientHost.fileChannel.write'
export const BROWSER_CLIENT_FILE_CHANNEL_ABORT_METHOD = 'browser.clientHost.fileChannel.abort'

export type BrowserClientDownloadDestination = {
  workspaceRelativePath: string
  hostLabel: string
}

export type BrowserClientDownloadRoute = {
  transferId: string
  browserPageId: string
  /** Temp file main hands to Chromium; never the user's Downloads folder. */
  stagingPath: string
  complete(filename: string): Promise<BrowserClientDownloadDestination>
  abort(): Promise<void>
}

export type BrowserClientDownloadRouteOutcome =
  /** This composition hosts no page behind the WebContents; another one may. */
  | { kind: 'unowned' }
  | { kind: 'remote'; route: BrowserClientDownloadRoute }
  /** Mixed-version host with no file channel: the deliberate desktop Downloads carve-out. */
  | { kind: 'local-fallback' }
  /** The owning page's channel is negotiated but not usable right now: fail closed. */
  | { kind: 'unavailable' }

type RelayFilesystem = {
  // Why: Electron's will-download handler must call setSavePath synchronously, so the staging
  // directory has to exist before the handler returns.
  mkdirSync(directory: string): void
  // Why: sync so the sweep cannot delete a transfer directory a download already staged into.
  removeDirectorySync(directory: string): void
  readChunks(filePath: string, chunkBytes: number): AsyncIterable<Buffer>
  size(filePath: string): Promise<number>
  removeDirectory(directory: string): Promise<void>
}

const nodeRelayFilesystem: RelayFilesystem = {
  mkdirSync: (directory) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  },
  removeDirectorySync: (directory) => {
    rmSync(directory, { recursive: true, force: true })
  },
  readChunks: async function* (filePath, chunkBytes) {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(chunkBytes)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null)
        if (bytesRead === 0) {
          return
        }
        yield Buffer.from(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  },
  size: async (filePath) => (await stat(filePath)).size,
  removeDirectory: async (directory) => {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Streams a client-hosted page's download into the remote workspace. Chromium writes into a
 * main-owned temp file, the bytes are pushed over the negotiated file channel, and the temp copy is
 * always removed — the desktop Downloads folder is never used for a client-placed page.
 */
export class BrowserClientDownloadRelay {
  private readonly filesystem: RelayFilesystem

  constructor(
    private readonly options: {
      stagingRoot: string
      /** Non-page-controlled label for the execution host, shown beside the remote destination. */
      hostLabel: string
      transport: BrowserClientFileChannelTransport
      resolvePage(guestWebContentsId: number): BrowserClientHostedPageInventory | undefined
      filesystem?: RelayFilesystem
    }
  ) {
    this.filesystem = options.filesystem ?? nodeRelayFilesystem
    try {
      // Why: an abnormal exit leaves staged bytes behind, and nothing else ever revisits this root.
      this.filesystem.removeDirectorySync(options.stagingRoot)
    } catch {
      // A root that cannot be swept still accepts fresh per-transfer directories.
    }
  }

  /**
   * Ownership first: a WebContents this composition does not own is `unowned` so the caller can keep
   * asking the composition that does, instead of reading one composition's miss as permission to
   * write the bytes to the client's Downloads folder.
   */
  route(input: { guestWebContentsId: number }): BrowserClientDownloadRouteOutcome {
    const page = this.options.resolvePage(input.guestWebContentsId)
    if (!page) {
      return { kind: 'unowned' }
    }
    const availability = this.options.transport.availability
    if (availability !== 'negotiated') {
      return availability === 'unsupported' ? { kind: 'local-fallback' } : { kind: 'unavailable' }
    }
    const transferId = randomUUID()
    const transfer: StagedTransfer = {
      transferId,
      directory: path.join(this.options.stagingRoot, transferId),
      stagingPath: path.join(this.options.stagingRoot, transferId, 'download'),
      canceled: false,
      aborting: null
    }
    try {
      this.filesystem.mkdirSync(transfer.directory)
    } catch {
      return { kind: 'unavailable' }
    }
    return {
      kind: 'remote',
      route: {
        transferId,
        browserPageId: page.browserPageId,
        stagingPath: transfer.stagingPath,
        complete: (filename) => this.complete(page, transfer, filename),
        abort: () => this.abort(page, transfer)
      }
    }
  }

  private async complete(
    page: BrowserClientHostedPageInventory,
    transfer: StagedTransfer,
    filename: string
  ): Promise<BrowserClientDownloadDestination> {
    const { transferId, stagingPath } = transfer
    try {
      assertNotCanceled(transfer)
      if (
        (await this.filesystem.size(stagingPath)) > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
      ) {
        throw new Error('browser_client_download_too_large')
      }
      const authority = fileChannelAuthority(page)
      let offset = 0
      for await (const chunk of this.filesystem.readChunks(
        stagingPath,
        BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES
      )) {
        // Why: the commit spans hundreds of round trips, so every resumption re-reads the cancel --
        // otherwise a canceled download keeps streaming and still lands in the remote workspace.
        assertNotCanceled(transfer)
        await this.write(authority, {
          transferId,
          filename,
          contentBase64: chunk.toString('base64'),
          offset,
          final: false
        })
        offset += chunk.byteLength
      }
      assertNotCanceled(transfer)
      // Why: an empty download still needs one final chunk so the remote commits a zero-byte file.
      const workspaceRelativePath = await this.write(authority, {
        transferId,
        filename,
        contentBase64: '',
        offset,
        final: true
      })
      if (!workspaceRelativePath) {
        throw new Error('browser_client_download_destination_missing')
      }
      return { workspaceRelativePath, hostLabel: this.options.hostLabel }
    } catch (error) {
      await this.abort(page, transfer)
      throw error
    } finally {
      await this.filesystem.removeDirectory(transfer.directory).catch(() => undefined)
    }
  }

  private async write(
    authority: ReturnType<typeof fileChannelAuthority>,
    chunk: {
      transferId: string
      filename: string
      contentBase64: string
      offset: number
      final: boolean
    }
  ): Promise<string | null> {
    const parsed = BrowserClientFileChannelWriteResult.safeParse(
      await this.options.transport.request(BROWSER_CLIENT_FILE_CHANNEL_WRITE_METHOD, {
        ...authority,
        ...chunk
      })
    )
    if (!parsed.success) {
      throw new Error('browser_client_download_chunk_rejected')
    }
    if (!chunk.final) {
      return null
    }
    if (!parsed.data.workspaceRelativePath) {
      throw new Error('browser_client_download_destination_missing')
    }
    return parsed.data.workspaceRelativePath
  }

  private abort(page: BrowserClientHostedPageInventory, transfer: StagedTransfer): Promise<void> {
    transfer.canceled = true
    // Why: a cancel and the streaming loop's own failure handler both abort the same transfer.
    transfer.aborting ??= this.dispatchAbort(page, transfer)
    return transfer.aborting
  }

  private async dispatchAbort(
    page: BrowserClientHostedPageInventory,
    transfer: StagedTransfer
  ): Promise<void> {
    await this.filesystem.removeDirectory(transfer.directory).catch(() => undefined)
    if (!this.options.transport.available) {
      return
    }
    await this.options.transport
      .request(BROWSER_CLIENT_FILE_CHANNEL_ABORT_METHOD, {
        ...fileChannelAuthority(page),
        transferId: transfer.transferId
      })
      .catch(() => undefined)
  }
}

type StagedTransfer = {
  transferId: string
  /** Owns the staged file: removing it is what keeps the staging root from growing per download. */
  directory: string
  stagingPath: string
  canceled: boolean
  aborting: Promise<void> | null
}

function assertNotCanceled(transfer: StagedTransfer): void {
  if (transfer.canceled) {
    throw new Error('browser_client_download_canceled')
  }
}

function fileChannelAuthority(page: BrowserClientHostedPageInventory) {
  return {
    fileChannelProtocolVersion: BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
    authorityRuntimeId: page.authorityRuntimeId,
    authorityEpoch: page.authorityEpoch,
    browserHostClientId: page.browserHostClientId,
    browserHostGeneration: page.browserHostGeneration,
    browserPageId: page.browserPageId,
    pageHostGeneration: page.pageHostGeneration
  }
}
