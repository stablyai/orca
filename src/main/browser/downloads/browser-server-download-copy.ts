import { open } from 'node:fs/promises'
import type { RuntimeFileReadChunkResult } from '../../../shared/file-content/runtime-file-read'
import type { BrowserServerDownloadCopyArgs } from '../../../shared/browser/downloads/browser-server-download-copy'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import {
  cleanupLocalTransferPath,
  createSiblingTransferPath,
  promoteDownloadedFileWithoutOverwrite
} from '../../ipc/filesystem/downloads/filesystem-download-promotion'
import { BROWSER_DOWNLOAD_COPY_MAX_BYTES } from '../guest-lifecycle/manager/downloads/browser-download-copy-offers'
import { browserDownloadDestinationReservations } from './browser-download-destination'

const COPY_READ_TIMEOUT_MS = 60_000
const COPY_RELEASE_TIMEOUT_MS = 10_000

// Running copies by copy id, for Cancel.
const runningCopies = new Map<string, AbortController>()

function isChunk(value: unknown): value is RuntimeFileReadChunkResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const chunk: Partial<Record<keyof RuntimeFileReadChunkResult, unknown>> = value
  return (
    typeof chunk.contentBase64 === 'string' &&
    Number.isSafeInteger(chunk.bytesRead) &&
    typeof chunk.eof === 'boolean'
  )
}

/**
 * Copies a download a paired server saved into this computer's Downloads, one slice at a time
 * straight to disk, under a free name. A failure or Cancel leaves nothing here; the server's copy
 * stays either way.
 */
export async function copyBrowserServerDownloadHere(
  args: BrowserServerDownloadCopyArgs,
  rendererGone: AbortSignal
): Promise<{ destinationPath: string }> {
  const { environmentId, copyId, expectedEnvironmentPairingRevision } = args
  if (runningCopies.has(copyId)) {
    throw new Error('This download is already being copied.')
  }
  const controller = new AbortController()
  runningCopies.set(copyId, controller)
  const signal = AbortSignal.any([controller.signal, rendererGone])
  const call = async (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const response = await callRuntimeEnvironment(
      getRuntimeEnvironmentRegistryRoot(),
      environmentId,
      method,
      params,
      timeoutMs,
      expectedEnvironmentPairingRevision,
      undefined,
      { signal }
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }
  const read = async (offset: number): Promise<RuntimeFileReadChunkResult> => {
    const chunk = await call('browser.readDownloadCopy', { copyId, offset }, COPY_READ_TIMEOUT_MS)
    if (!isChunk(chunk)) {
      throw new Error('The server returned an unreadable part of the file.')
    }
    return chunk
  }

  let reservationKey: string | null = null
  let tempPath: string | null = null
  let handle: Awaited<ReturnType<typeof open>> | null = null
  let saved = false
  try {
    const reserved = await browserDownloadDestinationReservations.reserveIncoming(args.filename)
    reservationKey = reserved.reservationKey
    tempPath = createSiblingTransferPath(reserved.savePath, 'download')
    handle = await open(tempPath, 'wx')
    let offset = 0
    // One slice is read while the one before it is written: at most two in memory.
    let next: Promise<RuntimeFileReadChunkResult> | null = read(0)
    while (next) {
      const chunk: RuntimeFileReadChunkResult = await next
      signal.throwIfAborted()
      const bytes = Buffer.from(chunk.contentBase64, 'base64')
      if (bytes.length !== chunk.bytesRead || (!chunk.eof && bytes.length === 0)) {
        throw new Error('The server stopped sending the file.')
      }
      offset += bytes.length
      // A server can't fill this disk past the cap it promised.
      if (offset > BROWSER_DOWNLOAD_COPY_MAX_BYTES) {
        throw new Error('The file is too large to copy.')
      }
      next = chunk.eof ? null : read(offset)
      // Awaited above on the next turn, or dropped with the copy if this write fails.
      next?.catch(() => {})
      await handle.writeFile(bytes)
    }
    await handle.close()
    handle = null
    signal.throwIfAborted()
    const destinationPath = await promoteDownloadedFileWithoutOverwrite(
      tempPath,
      reserved.savePath,
      async () => {
        const free = await browserDownloadDestinationReservations.reserveIncoming(args.filename)
        // The link that follows claims it.
        browserDownloadDestinationReservations.release(free.reservationKey)
        return free.savePath
      },
      signal
    )
    saved = true
    return { destinationPath }
  } finally {
    runningCopies.delete(copyId)
    browserDownloadDestinationReservations.release(reservationKey)
    await handle?.close().catch(() => {})
    if (!saved) {
      await cleanupLocalTransferPath(tempPath)
      // The server need not hold a copy nobody will finish.
      void callRuntimeEnvironment(
        getRuntimeEnvironmentRegistryRoot(),
        environmentId,
        'browser.releaseDownloadCopy',
        { copyId },
        COPY_RELEASE_TIMEOUT_MS,
        expectedEnvironmentPairingRevision,
        undefined,
        { background: true }
      ).catch(() => {})
    }
  }
}

/** Cancel: stops the copy and removes what it wrote here. */
export function cancelBrowserServerDownloadCopy(copyId: string): boolean {
  const controller = runningCopies.get(copyId)
  controller?.abort(new Error('Canceled.'))
  return controller !== undefined
}
