// Why: on Linux/Windows @parcel/watcher uses a brute-force backend that
// recursively walks the whole tree on a libuv threadpool thread before
// subscribe() resolves. On a huge tree backed by slow storage (a home dir on
// NFS opened as a worktree) that crawl can run for minutes. Running it here, in
// a dedicated worker thread or subprocess keeps it off the main/`serve`
// process's libuv pool so it can never starve static-asset serving, RPC crypto,
// or other clients (issue #5308). The worker owns the subscribe, the per-event
// stat fanout, and the event batching; the host only relays results.
import { stat } from 'fs/promises'
import { parentPort, workerData } from 'worker_threads'
import type * as ParcelWatcher from '@parcel/watcher'
import type { FsChangeEvent } from '../../shared/types'

const RUNTIME_FILE_WATCH_EVENT_STAT_LIMIT = 200
const RUNTIME_FILE_WATCH_STAT_CONCURRENCY = 8

type FileWatcherWorkerData = {
  rootPath: string
  ignore: string[]
}

// Messages the worker sends back to the host.
export type FileWatcherWorkerMessage =
  | { type: 'ready' }
  | { type: 'events'; events: FsChangeEvent[] }
  | { type: 'error'; message: string }

// Messages the host sends to the worker.
export type FileWatcherHostMessage = { type: 'unsubscribe' }

const CHILD_WORKER_DATA_ENV = 'ORCA_FILE_WATCHER_WORKER_DATA'

function readWorkerData(): FileWatcherWorkerData {
  if (parentPort) {
    return workerData as FileWatcherWorkerData
  }
  const raw = process.env[CHILD_WORKER_DATA_ENV]
  if (!raw) {
    throw new Error(`Missing ${CHILD_WORKER_DATA_ENV}`)
  }
  return JSON.parse(raw) as FileWatcherWorkerData
}

const data = readWorkerData()
let hostDisconnected = false
let disposeSubscription: (() => void) | undefined

if (!parentPort) {
  process.once('disconnect', () => {
    hostDisconnected = true
    disposeSubscription?.()
  })
}

function postToHost(message: FileWatcherWorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message)
    return
  }
  process.send?.(message)
}

function onHostMessage(listener: (message: FileWatcherHostMessage) => void): void {
  if (parentPort) {
    parentPort.on('message', listener)
    return
  }
  process.on('message', (message) => {
    listener(message as FileWatcherHostMessage)
  })
}

function closeHostChannel(): void {
  if (parentPort) {
    parentPort.close()
    return
  }
  process.disconnect?.()
}

/** Report a watcher failure to the host and ask the renderer to refresh from
 *  scratch (the overflow event), so a mid-stream error never leaves the
 *  explorer silently stale. */
function reportWatchError(err: unknown): void {
  postToHost({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  } satisfies FileWatcherWorkerMessage)
  postToHost({
    type: 'events',
    events: [{ kind: 'overflow', absolutePath: data.rootPath }]
  } satisfies FileWatcherWorkerMessage)
}

/** Run an async mapper over items with a bounded number in flight at once, so a
 *  large batch can't occupy every libuv threadpool thread in this worker. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function main(): Promise<void> {
  let watcher: typeof ParcelWatcher
  try {
    watcher = await import('@parcel/watcher')
  } catch (err) {
    postToHost({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    } satisfies FileWatcherWorkerMessage)
    return
  }

  const subscription = await watcher.subscribe(
    data.rootPath,
    (err, events) => {
      if (err) {
        reportWatchError(err)
        return
      }
      // Why: large watcher batches usually mean a generated directory or branch
      // switch. Avoid stat fanout and ask the renderer to refresh.
      if (events.length > RUNTIME_FILE_WATCH_EVENT_STAT_LIMIT) {
        postToHost({
          type: 'events',
          events: [{ kind: 'overflow', absolutePath: data.rootPath }]
        } satisfies FileWatcherWorkerMessage)
        return
      }
      void mapWithConcurrency(
        events,
        RUNTIME_FILE_WATCH_STAT_CONCURRENCY,
        async (event): Promise<FsChangeEvent> => {
          if (event.type === 'delete') {
            return { kind: event.type, absolutePath: event.path }
          }
          let isDirectory: boolean | undefined
          try {
            isDirectory = (await stat(event.path)).isDirectory()
          } catch {
            isDirectory = undefined
          }
          return { kind: event.type, absolutePath: event.path, isDirectory }
        }
      )
        .then((mapped) => {
          postToHost({ type: 'events', events: mapped } satisfies FileWatcherWorkerMessage)
        })
        // Why: without this, a throwing postMessage / stat becomes an unhandled
        // rejection that crashes the worker silently. Surface it instead.
        .catch((err: unknown) => reportWatchError(err))
    },
    { ignore: data.ignore }
  )

  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    void subscription.unsubscribe().finally(() => {
      closeHostChannel()
    })
  }
  disposeSubscription = dispose

  if (hostDisconnected) {
    dispose()
    return
  }

  // The crawl finished and the subscription is live.
  postToHost({ type: 'ready' } satisfies FileWatcherWorkerMessage)

  onHostMessage((message: FileWatcherHostMessage) => {
    if (message.type === 'unsubscribe') {
      dispose()
    }
  })
}

void main().catch((err: unknown) => {
  postToHost({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  } satisfies FileWatcherWorkerMessage)
})
