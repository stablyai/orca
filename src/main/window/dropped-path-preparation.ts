import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import {
  DragTempCopyBatch,
  closeDragTempSource,
  materializeDragTempPaths,
  releaseDragTempBatch,
  type DragTempCopyItemResult,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'
import {
  copyCheckedDragTempSource,
  isDragTempSourceChanged,
  writeCheckedDragTempSource,
  type CheckedDragTempSource
} from './checked-drag-temp-source'
import { mayNeedDragTempCopy } from './drag-temp-path'

const DRAG_TEMP_COPY_TIMEOUT_MS = 2 * 60 * 1000
export const MAX_PENDING_DRAG_TEMP_COPIES = 8

export type RendererDropLifetime = { signal: AbortSignal; dispose: () => void }
export type DroppedPathPreparationDeps = {
  platform: NodeJS.Platform
  getCopyEnvironment: () => Promise<DragTempCopyEnvironment>
  watchRenderer: () => RendererDropLifetime
  localChatAttachmentStore?: () => Promise<Pick<AgentSessionAttachmentStore, 'storeWith'> | null>
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
  // Why: a local chat's drag-temp files stay open, unread, and are written once into its store.
  const batch = new DragTempCopyBatch(
    request.consumer === 'local-chat' ? AGENT_SESSION_ATTACHMENT_MAX_BYTES : -1
  )
  let prepared: DragTempCopyItemResult[]
  try {
    const capture = materializeDragTempPaths(request.paths, env, signal, batch)
    prepared = await (signal ? rejectOnDropAbort(capture, signal) : capture)
    if (batch.opened.size > 0) {
      const handoff = storeOpenedSources(batch, env, localChatAttachmentStore, signal)
      await (signal ? rejectOnDropAbort(handoff, signal) : handoff)
      prepared = request.paths.map((path) => batch.completed.get(path)!)
    }
    signal?.throwIfAborted()
    batch.completed.clear()
  } catch (error) {
    batch.completed.clear()
    await releaseDragTempBatch(batch)
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
    result.status === 'opened' ||
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

async function storeOpenedSources(
  batch: DragTempCopyBatch,
  env: DragTempCopyEnvironment,
  getStore: DroppedPathPreparationDeps['localChatAttachmentStore'],
  signal?: AbortSignal
): Promise<void> {
  const pending = getStore?.().catch(() => null) ?? Promise.resolve(null)
  // Why abortable: a chat host that never finishes starting must not hold the open sources
  // past the drop's deadline; its late answer is simply ignored.
  const store = await (signal ? rejectOnDropAbort(pending, signal) : pending)
  for (const source of batch.opened) {
    signal?.throwIfAborted()
    batch.completed.set(
      source.sourcePath,
      await storeOpenedSource(source, store, env, batch, signal)
    )
    await closeDragTempSource(batch, source)
  }
}

async function storeOpenedSource(
  source: CheckedDragTempSource,
  store: Awaited<ReturnType<NonNullable<DroppedPathPreparationDeps['localChatAttachmentStore']>>>,
  env: DragTempCopyEnvironment,
  batch: DragTempCopyBatch,
  signal?: AbortSignal
): Promise<DragTempCopyItemResult> {
  if (store) {
    try {
      const destPath = await store.storeWith(source.name, (partPath) =>
        writeCheckedDragTempSource(source, partPath, signal)
      )
      return { sourcePath: source.sourcePath, status: 'imported', destPath }
    } catch (error) {
      signal?.throwIfAborted()
      if (isDragTempSourceChanged(error)) {
        // Why: the dropped bytes changed since the drop; a fallback copy would carry new ones.
        return { sourcePath: source.sourcePath, status: 'failed', reason: 'changed' }
      }
    }
  }
  // Store unavailable or its write failed: the same checked bytes as a private copy by path.
  return copyCheckedDragTempSource(source, env, batch, signal)
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
