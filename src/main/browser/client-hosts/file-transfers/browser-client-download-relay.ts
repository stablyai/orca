import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  BROWSER_CLIENT_FILE_CHANNEL_CHUNK_MAX_BYTES,
  BROWSER_CLIENT_FILE_CHANNEL_PROTOCOL_VERSION,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
  BrowserClientFileChannelWriteResult
} from '../../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserDownloadFinishedEvent } from '../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import type {
  BrowserClientDownloadRouteInput,
  BrowserClientDownloadRouteOutcome
} from './browser-client-download-routing'

export const BROWSER_CLIENT_FILE_CHANNEL_WRITE_METHOD = 'browser.clientHost.fileChannel.write'
export const BROWSER_CLIENT_FILE_CHANNEL_ABORT_METHOD = 'browser.clientHost.fileChannel.abort'
export const BROWSER_CLIENT_FILE_CHANNEL_BEGIN_METHOD = 'browser.clientHost.fileChannel.begin'

type RelayFilesystem = {
  // will-download must setSavePath synchronously, so create the directory before returning.
  mkdirSync(directory: string): void
  // Sweep synchronously before any new transfer can stage bytes.
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
      // Remove staging left by abnormal exits; no other cleanup revisits this root.
      this.filesystem.removeDirectorySync(options.stagingRoot)
    } catch {
      // Let new transfers try even if startup cleanup fails.
    }
  }

  route(input: BrowserClientDownloadRouteInput): BrowserClientDownloadRouteOutcome {
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
      aborting: null,
      begun: Promise.resolve(null)
    }
    try {
      this.filesystem.mkdirSync(transfer.directory)
    } catch {
      return { kind: 'unavailable' }
    }
    // Tells the page's host what started this download before any byte arrives. Only an older host
    // that lacks the method lets it go the ordinary way; any other failure fails the download, so a
    // download the host would have claimed never lands in the workspace instead.
    transfer.begun = this.options.transport
      .request(BROWSER_CLIENT_FILE_CHANNEL_BEGIN_METHOD, {
        ...fileChannelAuthority(page),
        transferId,
        filename: (input.filename || 'download').slice(0, 255),
        documentUrl: (input.documentUrl ?? '').slice(0, 8192),
        ...(input.agentDownload ? { agentDownload: true } : {})
      })
      .then(
        () => null,
        (error: unknown) => (hasRuntimeRpcErrorCode(error, 'method_not_found') ? null : error)
      )
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
  ): Promise<NonNullable<BrowserDownloadFinishedEvent['remoteDestination']>> {
    const { transferId, stagingPath } = transfer
    try {
      if ((await transfer.begun) !== null) {
        throw new Error('browser_client_download_begin_failed')
      }
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
        // Cancellation can arrive between chunks; recheck before every write.
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
      // Send a final chunk even for empty files so the remote commits them.
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
    // Cancellation and streaming failure may both abort the same transfer.
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
  directory: string
  stagingPath: string
  canceled: boolean
  aborting: Promise<void> | null
  /** Why the host couldn't be told the download began; null when it was, or predates `begin`. */
  begun: Promise<unknown>
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
