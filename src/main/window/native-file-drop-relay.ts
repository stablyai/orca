import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  isNativeFileDropPayload,
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropCopyFailureReason,
  type NativeFileDropPayload,
  type NativeFileDropRejectedPayload
} from '../../shared/native-file-drop'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import {
  getDragTempCopyRoot,
  materializeDragTempPaths,
  mayNeedDragTempCopy,
  scheduleDragTempCopySweep,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

// Why: copies run one at a time, so a hung copy must not hold every later copy forever.
const DRAG_TEMP_COPY_TIMEOUT_MS = 2 * 60 * 1000
// Why: a drop is one user gesture; more than this waiting means copies are stuck, not busy.
export const MAX_PENDING_DRAG_TEMP_COPIES = 8

type AcceptedNativeFileDropPayload = Exclude<NativeFileDropPayload, NativeFileDropRejectedPayload>

type RendererLifetime = { signal: AbortSignal; dispose: () => void }

type NativeFileDropQueueDeps = {
  forward: (payload: NativeFileDropPayload) => void
  platform: NodeJS.Platform
  getCopyEnvironment: () => Promise<DragTempCopyEnvironment>
  watchRenderer: () => RendererLifetime
  copyTimeoutMs?: number
}

export function registerFileDropRelay(mainWindow: BrowserWindow): void {
  const channel = 'terminal:file-dropped-from-preload'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeAllListeners(channel)
  const enqueue = createNativeFileDropQueue({
    // Why: one IPC event per drop gesture so the renderer gets the full path batch without timer-based reconstruction.
    forward: (payload) => {
      if (!isWindowGone()) {
        mainWebContents.send('terminal:file-drop', payload)
      }
    },
    platform: process.platform,
    getCopyEnvironment: async () => ({
      platform: process.platform,
      sourceTempRoot: await getDarwinUserTempDir(),
      copyRoot: getDragTempCopyRoot(app.getPath('temp'))
    }),
    watchRenderer: () => abortWhenRendererGone(mainWebContents)
  })
  const relayFileDrop = (event: Electron.IpcMainEvent, args: NativeFileDropPayload): void => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      return
    }
    // Why: only main reports a failed copy; a renderer claiming one is ignored.
    if (!isNativeFileDropPayload(args) || isTempCopyFailure(args)) {
      return
    }
    enqueue(args)
  }
  ipcMain.on(channel, relayFileDrop)
  mainWindow.on('closed', () => {
    // Why: macOS keeps the process alive after window close; drop the closure so the destroyed window isn't retained.
    ipcMain.removeListener(channel, relayFileDrop)
  })
  scheduleDragTempCopySweep(() => getDragTempCopyRoot(app.getPath('temp')))
}

/**
 * A drop holding a macOS drag-temp path waits for main to copy it, because the
 * PTY daemon cannot open the original. Those copies run one at a time, in order,
 * under one byte budget. Other drops are forwarded at once unless an earlier drop
 * is still queued, so drops reach the renderer in the order they were made.
 */
export function createNativeFileDropQueue(
  deps: NativeFileDropQueueDeps
): (payload: NativeFileDropPayload) => void {
  let tail = Promise.resolve()
  let queued = 0
  let pendingCopies = 0
  const enqueue = (
    deliver: (lifetime: RendererLifetime) => Promise<void> | void,
    isCopy: boolean
  ): void => {
    queued += 1
    pendingCopies += isCopy ? 1 : 0
    // Why: bind to the document that dropped now, so a reload while this waits discards it.
    const lifetime = deps.watchRenderer()
    // Why: never reject, or one failed drop would stall every drop queued behind it.
    tail = tail
      .then(() => (lifetime.signal.aborted ? undefined : deliver(lifetime)))
      .catch(() => undefined)
      .finally(() => {
        queued -= 1
        pendingCopies -= isCopy ? 1 : 0
        lifetime.dispose()
      })
  }
  const forwardInOrder = (payload: NativeFileDropPayload): void => {
    // Why: a rejection carries no paths, so only path drops wait their turn.
    if (payload.target === 'rejected' || queued === 0) {
      deps.forward(payload)
    } else {
      enqueue(() => deps.forward(payload), false)
    }
  }
  return (payload) => {
    if (payload.target === 'rejected' || !needsDragTempCopy(payload, deps.platform)) {
      forwardInOrder(payload)
      return
    }
    if (pendingCopies >= MAX_PENDING_DRAG_TEMP_COPIES) {
      for (const item of failWholeDrop(payload, deps.platform, 'busy')) {
        forwardInOrder(item)
      }
      return
    }
    enqueue((lifetime) => copyAndForward(payload, lifetime, deps), true)
  }
}

/** The payloads to forward for one drop: its prepared paths, then a rejection for any it lost. */
export async function prepareNativeFileDrop(
  payload: AcceptedNativeFileDropPayload,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<NativeFileDropPayload[]> {
  const results = await materializeDragTempPaths(payload.paths, env, signal)
  // Why: agents run under the PTY daemon, which cannot open an uncopied original;
  // other targets are read by main, so the original still works there.
  const acceptsOriginal =
    payload.target !== NATIVE_FILE_DROP_TARGET.terminal &&
    payload.target !== NATIVE_FILE_DROP_TARGET.composer
  const paths = results.flatMap((result) =>
    result.status === 'imported'
      ? [result.destPath]
      : result.status === 'uncopied' && acceptsOriginal
        ? [result.sourcePath]
        : []
  )
  const unprepared = results.flatMap((result) =>
    result.status === 'imported' || (result.status === 'uncopied' && acceptsOriginal)
      ? []
      : [result]
  )
  const prepared: NativeFileDropPayload[] = paths.length > 0 ? [{ ...payload, paths }] : []
  if (unprepared.length > 0) {
    const commonReason = unprepared.every((item) => item.reason === unprepared[0].reason)
      ? unprepared[0].reason
      : undefined
    prepared.push(copyFailure(unprepared.length, commonReason))
  }
  return prepared
}

/** When the copy stage fails as a whole, still deliver the paths that never needed a copy. */
function failWholeDrop(
  payload: AcceptedNativeFileDropPayload,
  platform: NodeJS.Platform,
  reason: NativeFileDropCopyFailureReason | undefined
): NativeFileDropPayload[] {
  const ordinary = payload.paths.filter((path) => !mayNeedDragTempCopy(path, platform))
  const lost = payload.paths.length - ordinary.length
  return [
    ...(ordinary.length > 0 ? [{ ...payload, paths: ordinary }] : []),
    ...(lost > 0 ? [copyFailure(lost, reason)] : [])
  ]
}

function forwardAll(deps: NativeFileDropQueueDeps, payloads: NativeFileDropPayload[]): void {
  for (const payload of payloads) {
    deps.forward(payload)
  }
}

function isTempCopyFailure(payload: NativeFileDropPayload): boolean {
  return payload.target === 'rejected' && payload.reason === 'temp-copy-failed'
}

function needsDragTempCopy(
  payload: AcceptedNativeFileDropPayload,
  platform: NodeJS.Platform
): boolean {
  return payload.paths.some((path) => mayNeedDragTempCopy(path, platform))
}

async function copyAndForward(
  payload: AcceptedNativeFileDropPayload,
  lifetime: RendererLifetime,
  deps: NativeFileDropQueueDeps
): Promise<void> {
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('Copying the dropped files took too long')),
    deps.copyTimeoutMs ?? DRAG_TEMP_COPY_TIMEOUT_MS
  )
  const signal = AbortSignal.any([lifetime.signal, timeout.signal])
  let prepared: NativeFileDropPayload[]
  try {
    // Why: race the signal too, since a hung fs call never reaches the copy's abort checks.
    prepared = await rejectOnAbort(
      deps.getCopyEnvironment().then((env) => prepareNativeFileDrop(payload, env, signal)),
      signal
    )
  } catch {
    // Why: an aborted drop has no renderer to report to; anything else must not vanish silently.
    if (lifetime.signal.aborted) {
      return
    }
    prepared = failWholeDrop(
      payload,
      deps.platform,
      timeout.signal.aborted ? 'timed-out' : undefined
    )
  } finally {
    clearTimeout(timer)
  }
  // Why: outside the try, so a failed forward is not reported a second time as a failed copy.
  forwardAll(deps, prepared)
}

function rejectOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function copyFailure(
  pathCount: number,
  commonReason?: NativeFileDropCopyFailureReason
): NativeFileDropRejectedPayload {
  return {
    byteLength: 0,
    pathCount,
    reason: 'temp-copy-failed',
    target: 'rejected',
    ...(commonReason ? { commonReason } : {})
  }
}
