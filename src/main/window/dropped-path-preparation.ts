import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import {
  materializeDragTempPaths,
  mayNeedDragTempCopy,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'

const DRAG_TEMP_COPY_TIMEOUT_MS = 2 * 60 * 1000
export const MAX_PENDING_DRAG_TEMP_COPIES = 8

export type RendererDropLifetime = { signal: AbortSignal; dispose: () => void }
export type DroppedPathPreparationDeps = {
  platform: NodeJS.Platform
  getCopyEnvironment: () => Promise<DragTempCopyEnvironment>
  watchRenderer: () => RendererDropLifetime
  copyTimeoutMs?: number
}

export function createDragTempCopyLane(): { tail: Promise<void>; pending: number } {
  return { tail: Promise.resolve(), pending: 0 }
}

// Why: replacement windows still share the retained-copy budget with work already in flight.
export const windowDragTempCopyLane = createDragTempCopyLane()

export function createDroppedPathPreparationQueue(
  deps: DroppedPathPreparationDeps,
  lane = createDragTempCopyLane()
): (request: PrepareDroppedPathsRequest) => PreparedDroppedPaths | Promise<PreparedDroppedPaths> {
  return (request) => {
    if (!request.paths.some((path) => mayNeedDragTempCopy(path, deps.platform))) {
      return { paths: [...request.paths], failures: [] }
    }
    if (lane.pending >= MAX_PENDING_DRAG_TEMP_COPIES) {
      return failDroppedPathPreparation(request.paths, deps.platform, 'busy')
    }
    const lifetime = deps.watchRenderer()
    lane.pending += 1
    const prepared = lane.tail.then(() => {
      lifetime.signal.throwIfAborted()
      return copyDroppedPaths(request, lifetime.signal, deps)
    })
    lane.tail = prepared
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        lane.pending -= 1
        lifetime.dispose()
      })
    // Why: a reloaded document must stop waiting even while its request is queued.
    return rejectOnDropAbort(prepared, lifetime.signal)
  }
}

export async function prepareDroppedPaths(
  request: PrepareDroppedPathsRequest,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<PreparedDroppedPaths> {
  const results = await materializeDragTempPaths(request.paths, env, signal)
  const acceptsOriginal = request.consumer === 'main-reader'
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
  const commonReason = unprepared.every((item) => item.reason === unprepared[0]?.reason)
    ? unprepared[0]?.reason
    : undefined
  return {
    paths,
    failures: unprepared.length > 0 ? [copyFailure(unprepared.length, commonReason)] : []
  }
}

function failDroppedPathPreparation(
  paths: readonly string[],
  platform: NodeJS.Platform,
  reason?: NativeFileDropCopyFailureReason
): PreparedDroppedPaths {
  const ordinary = paths.filter((path) => !mayNeedDragTempCopy(path, platform))
  const lost = paths.length - ordinary.length
  return {
    paths: ordinary,
    failures: lost > 0 ? [copyFailure(lost, reason)] : []
  }
}

async function copyDroppedPaths(
  request: PrepareDroppedPathsRequest,
  rendererSignal: AbortSignal,
  deps: DroppedPathPreparationDeps
): Promise<PreparedDroppedPaths> {
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('Copying the dropped files took too long')),
    deps.copyTimeoutMs ?? DRAG_TEMP_COPY_TIMEOUT_MS
  )
  const signal = AbortSignal.any([rendererSignal, timeout.signal])
  try {
    return await rejectOnDropAbort(
      deps.getCopyEnvironment().then((env) => prepareDroppedPaths(request, env, signal)),
      signal
    )
  } catch (error) {
    if (rendererSignal.aborted) {
      throw error
    }
    return failDroppedPathPreparation(
      request.paths,
      deps.platform,
      timeout.signal.aborted ? 'timed-out' : undefined
    )
  } finally {
    clearTimeout(timer)
  }
}

export function rejectOnDropAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function copyFailure(pathCount: number, commonReason?: NativeFileDropCopyFailureReason) {
  return {
    byteLength: 0,
    pathCount,
    reason: 'temp-copy-failed' as const,
    target: 'rejected' as const,
    ...(commonReason ? { commonReason } : {})
  }
}
