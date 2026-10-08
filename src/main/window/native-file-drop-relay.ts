import { app, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  createRejectedNativeFileDropPayload,
  isNativeFileDropPayload,
  NATIVE_FILE_DROP_TARGET,
  validateNativeFileDropPaths,
  type NativeFileDropPayload,
  type NativeFileDropRejectedPayload
} from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { getDragTempCopyRoot, scheduleDragTempCopySweep } from './dragged-temp-file-copy'
import {
  createDroppedPathPreparationQueue,
  type createDragTempCopyLane,
  prepareDroppedPaths,
  windowDragTempCopyLane,
  type DroppedPathPreparationDeps
} from './dropped-path-preparation'
import type { DragTempCopyEnvironment } from './dragged-temp-file-copy'
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

export { MAX_PENDING_DRAG_TEMP_COPIES } from './dropped-path-preparation'

type AcceptedNativeFileDropPayload = Exclude<NativeFileDropPayload, NativeFileDropRejectedPayload>
type NativeFileDropQueueDeps = DroppedPathPreparationDeps & {
  forward: (payload: NativeFileDropPayload) => void
}
type NativeFileDropQueue = ((payload: NativeFileDropPayload) => void) & {
  prepare: (request: PrepareDroppedPathsRequest) => Promise<PreparedDroppedPaths>
}

export function registerFileDropRelay(mainWindow: BrowserWindow): void {
  const channel = 'terminal:file-dropped-from-preload'
  const prepareChannel = 'fs:prepareDroppedPaths'
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  ipcMain.removeAllListeners(channel)
  ipcMain.removeHandler(prepareChannel)
  const enqueue = createNativeFileDropQueue(
    {
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
    },
    windowDragTempCopyLane
  )
  const relayFileDrop = (event: Electron.IpcMainEvent, args: NativeFileDropPayload): void => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      return
    }
    if (!isNativeFileDropPayload(args) || isTempCopyFailure(args)) {
      return
    }
    enqueue(args)
  }
  ipcMain.on(channel, relayFileDrop)
  const prepareHandler = (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      throw new Error('Dropped paths must come from the owning window')
    }
    if (!isPrepareDroppedPathsRequest(args)) {
      throw new Error('Invalid dropped paths request')
    }
    const validation = validateNativeFileDropPaths(args.paths)
    if (validation.status === 'rejected') {
      return Promise.resolve({
        paths: [],
        failures: [createRejectedNativeFileDropPayload(validation)]
      })
    }
    return enqueue.prepare(args)
  }
  ipcMain.handle(prepareChannel, prepareHandler)
  activePrepareHandler = prepareHandler
  mainWindow.on('closed', () => {
    ipcMain.removeListener(channel, relayFileDrop)
    // Why: an old window closing late must not remove the replacement window's handler.
    if (activePrepareHandler === prepareHandler) {
      ipcMain.removeHandler(prepareChannel)
      activePrepareHandler = undefined
    }
  })
  scheduleDragTempCopySweep(() => getDragTempCopyRoot(app.getPath('temp')))
}

let activePrepareHandler: unknown

/** Legacy delivery stays ordered; new owners share only the serialized copy work. */
export function createNativeFileDropQueue(
  deps: NativeFileDropQueueDeps,
  lane?: ReturnType<typeof createDragTempCopyLane>
): NativeFileDropQueue {
  const prepare = createDroppedPathPreparationQueue(deps, lane)
  let deliveryTail = Promise.resolve()
  let queuedDeliveries = 0
  const deliver = (payloads: NativeFileDropPayload[]): void => {
    for (const payload of payloads) {
      deps.forward(payload)
    }
  }
  const enqueueDelivery = (work: () => Promise<void> | void): void => {
    queuedDeliveries += 1
    deliveryTail = deliveryTail
      .then(work)
      .catch(() => undefined)
      .finally(() => {
        queuedDeliveries -= 1
      })
  }
  const forwardInOrder = (payload: NativeFileDropPayload): void => {
    if (payload.target === 'rejected' || queuedDeliveries === 0) {
      deps.forward(payload)
      return
    }
    const lifetime = deps.watchRenderer()
    enqueueDelivery(() => {
      try {
        if (!lifetime.signal.aborted) {
          deps.forward(payload)
        }
      } finally {
        lifetime.dispose()
      }
    })
  }
  const enqueue = (payload: NativeFileDropPayload): void => {
    if (payload.target === 'rejected') {
      forwardInOrder(payload)
      return
    }
    const prepared = prepare({ paths: payload.paths, consumer: legacyConsumer(payload) })
    if (!(prepared instanceof Promise)) {
      if (payload.paths.length === 0) {
        forwardInOrder(payload)
        return
      }
      for (const item of legacyPayloads(payload, prepared)) {
        forwardInOrder(item)
      }
      return
    }
    // Why: observe rejection now, even while legacy delivery waits behind an earlier drop.
    const result = prepared.then(
      (value) => legacyPayloads(payload, value),
      () => []
    )
    enqueueDelivery(async () => deliver(await result))
  }
  return Object.assign(enqueue, {
    prepare: async (request: PrepareDroppedPathsRequest) => prepare(request)
  })
}

export async function prepareNativeFileDrop(
  payload: AcceptedNativeFileDropPayload,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<NativeFileDropPayload[]> {
  return legacyPayloads(
    payload,
    await prepareDroppedPaths(
      { paths: payload.paths, consumer: legacyConsumer(payload) },
      env,
      signal
    )
  )
}

function legacyConsumer(
  payload: AcceptedNativeFileDropPayload
): PrepareDroppedPathsRequest['consumer'] {
  return payload.target === NATIVE_FILE_DROP_TARGET.terminal ||
    payload.target === NATIVE_FILE_DROP_TARGET.composer
    ? 'agent'
    : 'main-reader'
}

function legacyPayloads(
  payload: AcceptedNativeFileDropPayload,
  prepared: PreparedDroppedPaths
): NativeFileDropPayload[] {
  return [
    ...(prepared.paths.length > 0 ? [{ ...payload, paths: prepared.paths }] : []),
    ...prepared.failures
  ]
}

function isTempCopyFailure(payload: NativeFileDropPayload): boolean {
  return payload.target === 'rejected' && payload.reason === 'temp-copy-failed'
}

function isPrepareDroppedPathsRequest(value: unknown): value is PrepareDroppedPathsRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'consumer' in value &&
    (value.consumer === 'agent' || value.consumer === 'main-reader') &&
    'paths' in value &&
    Array.isArray(value.paths) &&
    value.paths.every((path: unknown) => typeof path === 'string')
  )
}
