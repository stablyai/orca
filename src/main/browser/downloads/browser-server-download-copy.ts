import { open, type FileHandle } from 'node:fs/promises'
import type {
  BrowserServerDownloadCopyArgs,
  BrowserServerDownloadCopyResult
} from '../../../shared/browser/downloads/browser-server-download-copy'
import {
  BROWSER_DOWNLOAD_COPY_FRAME_BYTES,
  BROWSER_DOWNLOAD_COPY_FRAME_KIND,
  BROWSER_DOWNLOAD_COPY_WINDOW_BYTES,
  encodeBrowserDownloadCopyAck,
  readBrowserDownloadCopyStreamEvent
} from '../../../shared/browser/downloads/browser-download-copy-stream'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { runtimeEnvironmentRevisionFailure } from '../../ipc/runtime-environments/requests/runtime-environment-revision-guard'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { onRuntimeEnvironmentTransportGenerationRetired } from '../../ipc/runtime-environments/connections/runtime-environment-transport-generation'
import {
  cleanupLocalTransferPath,
  createSiblingTransferPath,
  promoteDownloadedFileWithoutOverwrite
} from '../../ipc/filesystem/downloads/filesystem-download-promotion'
import { BROWSER_DOWNLOAD_COPY_MAX_BYTES } from '../guest-lifecycle/manager/downloads/browser-download-copy-offers'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/remote-runtime/rpc/runtime-rpc-feature-interaction-source'

const COPY_START_TIMEOUT_MS = 60_000
const COPY_PROGRESS_TIMEOUT_MS = 60_000
const COPY_RELEASE_TIMEOUT_MS = 10_000

// Running copies by copy id, for Cancel; `finishing` once the file is being moved into Downloads.
type RunningCopy = {
  controller: AbortController
  // Aborts on Cancel, a retired connection or the window going away, whichever comes first.
  signal: AbortSignal
  finishing: boolean
  // The stream stopped on a failure; the copy is only waiting for its file to settle.
  failed: boolean
  // Set only when Cancel is what stopped it: its own reason, so nothing else is taken for it.
  cancelReason: Error | null
}
const runningCopies = new Map<string, RunningCopy>()

/**
 * Copies a download a paired server saved into this computer's Downloads under a free name. The
 * server streams it as binary frames on the stream's own socket and sends each next one only once
 * this side has written it to disk, so memory stays one window whatever the file's size. A failure
 * or Cancel before the move into Downloads leaves nothing here; the server's copy stays either way.
 */
export async function copyBrowserServerDownloadHere(
  args: BrowserServerDownloadCopyArgs,
  rendererGone: AbortSignal
): Promise<BrowserServerDownloadCopyResult> {
  const { environmentId, copyId, expectedEnvironmentPairingRevision } = args
  if (runningCopies.has(copyId)) {
    throw new Error('This download is already being copied.')
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, rendererGone])
  const running: RunningCopy = {
    controller,
    signal,
    finishing: false,
    failed: false,
    cancelReason: null
  }
  runningCopies.set(copyId, running)
  const isCancel = (error: unknown): boolean =>
    running.cancelReason !== null && error === running.cancelReason
  // Removing or re-pairing the server retires its transport; this copy's socket goes with it.
  const stopRetirement = onRuntimeEnvironmentTransportGenerationRetired((retired) => {
    if (retired === environmentId) {
      controller.abort(new Error('The connection to the server changed. Download it again.'))
    }
  })

  let reservationKey: string | null = null
  const retryReservationKeys: string[] = []
  let tempPath: string | null = null
  let handle: FileHandle | null = null
  // Set once the stream opens; acks and close go through it.
  const stream: { subscription: RemoteRuntimeTransportSubscription | null } = { subscription: null }
  let saved = false
  try {
    // A copy id names a file only on the pairing that sent it.
    const environment = await resolveEnvironment(getRuntimeEnvironmentRegistryRoot(), environmentId)
    const changed = runtimeEnvironmentRevisionFailure(
      environment,
      expectedEnvironmentPairingRevision,
      'browser.downloadCopyStream'
    )
    if (changed && !changed.ok) {
      throw new Error(changed.error.message)
    }
    const reserved = await browserDownloadDestinationReservations.reserveIncoming(args.filename)
    reservationKey = reserved.reservationKey
    tempPath = createSiblingTransferPath(reserved.savePath, 'download')
    const file = await open(tempPath, 'wx')
    handle = file
    // Frames are written one after another. Once the stream stops none starts, but one already
    // being written is waited for before the outcome is decided (below).
    let writes: Promise<void> = Promise.resolve()
    const streamFailure = await new Promise<void>((resolve, reject) => {
      let size: number | null = null
      let received = 0
      let written = 0
      let ended = false
      let settled = false
      // A server whose socket stays up but whose file stops arriving frees everything here.
      const stall = setTimeout(
        () => fail(new Error('The server stopped sending the file.')),
        COPY_PROGRESS_TIMEOUT_MS
      )
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true
          running.failed = true
          clearTimeout(stall)
          reject(error)
        }
      }
      const finishIfDone = (): void => {
        if (!settled && ended && size !== null && written === size) {
          settled = true
          clearTimeout(stall)
          resolve()
        }
      }
      const abortReason = (): Error =>
        signal.reason instanceof Error ? signal.reason : new Error('Canceled.')
      if (signal.aborted) {
        fail(abortReason())
        return
      }
      signal.addEventListener('abort', () => fail(abortReason()), { once: true })
      const onBinary = (frame: Uint8Array): void => {
        // Every frame but the last is full, so at most a window of writes ever waits here.
        const bytes = frame.subarray(1)
        const expected =
          size === null ? 0 : Math.min(BROWSER_DOWNLOAD_COPY_FRAME_BYTES, size - received)
        received += bytes.byteLength
        if (
          frame[0] !== BROWSER_DOWNLOAD_COPY_FRAME_KIND ||
          expected === 0 ||
          bytes.byteLength !== expected ||
          received - written > BROWSER_DOWNLOAD_COPY_WINDOW_BYTES
        ) {
          fail(new Error('The server sent an unexpected part of the file.'))
          return
        }
        writes = writes.then(async () => {
          for (let offset = 0; offset < bytes.byteLength;) {
            if (settled) {
              return
            }
            offset += (await file.write(bytes, offset, bytes.byteLength - offset)).bytesWritten
          }
          written += bytes.byteLength
          stall.refresh()
          stream.subscription?.sendBinary(encodeBrowserDownloadCopyAck(written))
          finishIfDone()
        })
        writes.catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error(String(error)))
        )
      }
      void subscribeRuntimeEnvironment(
        getRuntimeEnvironmentRegistryRoot(),
        environmentId,
        'browser.downloadCopyStream',
        // Orca's own window asked, not an agent: no browser-use interaction to record.
        withBrowserPaneUiRuntimeRpcSource({ copyId }),
        COPY_START_TIMEOUT_MS,
        {
          onEvent: (payload) => {
            stall.refresh()
            if (payload.type === 'binary') {
              onBinary(payload.bytes)
              return
            }
            if (payload.type === 'error') {
              fail(new Error(payload.message))
              return
            }
            if (payload.type === 'close') {
              fail(new Error('The server stopped sending the file.'))
              return
            }
            if (!payload.response.ok) {
              fail(new Error(payload.response.error.message))
              return
            }
            const event = readBrowserDownloadCopyStreamEvent(payload.response.result)
            if (event?.type === 'start' && size === null) {
              // A server can't fill this disk past the cap it promised.
              if (event.size > BROWSER_DOWNLOAD_COPY_MAX_BYTES) {
                fail(new Error('The file is too large to copy.'))
                return
              }
              size = event.size
            } else if (event?.type === 'end' && size !== null) {
              ended = true
              finishIfDone()
            } else {
              fail(new Error('The server sent an unreadable reply.'))
            }
          },
          onClose: () => fail(new Error('The server stopped sending the file.'))
        },
        () => !settled,
        signal
      ).then(
        (opened) => {
          stream.subscription = opened
          if (settled) {
            opened.close()
          } else if (written > 0) {
            // Frames written before the subscription handle arrived.
            opened.sendBinary(encodeBrowserDownloadCopyAck(written))
          }
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
      )
    }).then(
      () => null,
      (error: unknown) => error
    )
    stream.subscription?.close()
    stream.subscription = null
    const writeFailure = await writes.then(
      () => null,
      (error: unknown) => error
    )
    handle = null
    // Network shares and full disks can report a lost write only when the file closes.
    const closeFailure = await file.close().then(
      () => null,
      (error: unknown) => error
    )
    // What stopped the stream is reported, unless it was Cancel: a write already under way or the
    // close failing is the disk's own failure, which Cancel didn't cause and mustn't hide.
    const failure =
      streamFailure !== null && !isCancel(streamFailure)
        ? streamFailure
        : (writeFailure ?? closeFailure ?? streamFailure)
    if (failure !== null) {
      throw failure
    }
    signal.throwIfAborted()
    // Too late to cancel from here: a copy stopped partway into Downloads couldn't be safely removed.
    running.finishing = true
    const destinationPath = await promoteDownloadedFileWithoutOverwrite(
      tempPath,
      reserved.savePath,
      async () => {
        // Held until the move, so a browser download can't be handed the same name meanwhile.
        const free = await browserDownloadDestinationReservations.reserveIncoming(args.filename)
        retryReservationKeys.push(free.reservationKey)
        return free.savePath
      },
      signal
    )
    saved = true
    return { canceled: false, destinationPath }
  } catch (error) {
    // Only Cancel's own reason counts: a failure it didn't cause still shows.
    if (isCancel(error)) {
      return { canceled: true }
    }
    throw error
  } finally {
    stopRetirement()
    runningCopies.delete(copyId)
    stream.subscription?.close()
    for (const key of [reservationKey, ...retryReservationKeys]) {
      browserDownloadDestinationReservations.release(key)
    }
    await handle?.close().catch(() => {})
    if (!saved) {
      await cleanupLocalTransferPath(tempPath)
      // The server need not hold a copy nobody will finish.
      void callRuntimeEnvironment(
        getRuntimeEnvironmentRegistryRoot(),
        environmentId,
        'browser.releaseDownloadCopy',
        withBrowserPaneUiRuntimeRpcSource({ copyId }),
        COPY_RELEASE_TIMEOUT_MS,
        expectedEnvironmentPairingRevision,
        undefined,
        { background: true }
      ).catch(() => {})
    }
  }
}

/**
 * Cancel: stops the copy and removes what it wrote here. False when there is nothing to cancel, it
 * already stopped (a failure, a retired connection, the window closing, an earlier Cancel), or the
 * file is already being moved into Downloads; the copy then ends saved or failed as usual.
 */
export function cancelBrowserServerDownloadCopy(copyId: string): boolean {
  const running = runningCopies.get(copyId)
  if (!running || running.finishing || running.failed || running.signal.aborted) {
    return false
  }
  running.cancelReason = new Error('Canceled.')
  running.controller.abort(running.cancelReason)
  return true
}
