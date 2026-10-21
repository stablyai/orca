import { basename } from 'node:path'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import {
  DragTempCopyBatch,
  stageCapturedDragTempBytes,
  materializeDragTempPaths,
  removeCreatedDragTempCopies,
  type DragTempCopyItemResult,
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
  localChatAttachmentStore?: () => Promise<Pick<
    AgentSessionAttachmentStore,
    'storeFile' | 'importFreshFile'
  > | null>
  copyTimeoutMs?: number
}

export function createDragTempCopyLane(): { tail: Promise<void>; pending: number } {
  return { tail: Promise.resolve(), pending: 0 }
}

// Why: replacement windows share the copy queue with work already in flight.
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
  signal?: AbortSignal,
  localChatAttachmentStore?: DroppedPathPreparationDeps['localChatAttachmentStore']
): Promise<PreparedDroppedPaths> {
  const batch = new DragTempCopyBatch(
    request.consumer === 'local-chat' ? AGENT_SESSION_ATTACHMENT_MAX_BYTES : -1
  )
  let prepared: DragTempCopyItemResult[]
  try {
    const capture = materializeDragTempPaths(request.paths, env, signal, batch)
    prepared = await (signal ? rejectOnDropAbort(capture, signal) : capture)
    if (request.consumer === 'local-chat') {
      prepared = []
      const handoff = storeCreatedCopies(batch, env, localChatAttachmentStore, signal)
      await (signal ? rejectOnDropAbort(handoff, signal) : handoff)
      prepared = request.paths.map((path) => batch.completed.get(path)!)
    }
    signal?.throwIfAborted()
    batch.completed.clear()
  } catch (error) {
    batch.completed.clear()
    await removeCreatedDragTempCopies(batch.directories)
    throw error
  }
  const acceptsOriginal = request.consumer === 'main-reader'
  const paths = prepared.flatMap((result) =>
    result.status === 'imported'
      ? [result.destPath]
      : result.status === 'uncopied' && acceptsOriginal
        ? [result.sourcePath]
        : []
  )
  const unprepared = prepared.flatMap((result) =>
    result.status === 'buffered' ||
    result.status === 'imported' ||
    (result.status === 'uncopied' && acceptsOriginal)
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

async function storeCreatedCopies(
  batch: DragTempCopyBatch,
  env: DragTempCopyEnvironment,
  getStore: DroppedPathPreparationDeps['localChatAttachmentStore'],
  signal?: AbortSignal
): Promise<void> {
  let storePromise:
    | ReturnType<NonNullable<DroppedPathPreparationDeps['localChatAttachmentStore']>>
    | undefined
  for (const [sourcePath, result] of batch.completed) {
    signal?.throwIfAborted()
    const buffered = result.status === 'buffered'
    const file =
      result.status === 'imported' &&
      result.directory &&
      result.byteLength !== undefined &&
      result.byteLength <= AGENT_SESSION_ATTACHMENT_MAX_BYTES
    if (!buffered && !file) {
      continue
    }
    let stored: string | undefined
    try {
      const store = await (storePromise ??= getStore?.().catch(() => null) ?? Promise.resolve(null))
      signal?.throwIfAborted()
      if (store) {
        stored = buffered
          ? await store.storeFile(basename(sourcePath), result.bytes)
          : result.status === 'imported' && result.byteLength !== undefined
            ? await store.importFreshFile(basename(sourcePath), result.destPath, result.byteLength)
            : undefined
      }
    } catch {
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    if (stored) {
      batch.completed.set(sourcePath, { sourcePath, status: 'imported', destPath: stored })
      if (result.status === 'imported' && result.directory) {
        await removeCreatedDragTempCopies([result.directory])
      }
    } else if (buffered) {
      batch.completed.set(
        sourcePath,
        await stageCapturedDragTempBytes(sourcePath, result.bytes, env, batch, signal)
      )
    }
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
      deps
        .getCopyEnvironment()
        .then((env) => prepareDroppedPaths(request, env, signal, deps.localChatAttachmentStore)),
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
