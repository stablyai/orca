// Why: on Linux/Windows @parcel/watcher uses a brute-force backend that
// recursively walks the whole tree on a libuv threadpool thread before
// subscribe() resolves. On a huge tree backed by slow storage (a home dir on
// NFS opened as a worktree) that crawl can run for minutes. Running it here, in
// a dedicated worker thread, keeps it off the main/`serve` process's libuv pool
// so it can never starve static-asset serving, RPC crypto, or other clients
// (issue #5308). The worker owns the subscribe, the per-event stat fanout, and
// the event batching; the main thread only relays results.
import { stat } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
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

const data = workerData as FileWatcherWorkerData

if (!parentPort) {
  throw new Error('File watcher worker must run with a parent port.')
}

const port = parentPort

/** Report a watcher failure to the host and ask the renderer to refresh from
 *  scratch (the overflow event), so a mid-stream error never leaves the
 *  explorer silently stale. */
function reportWatchError(err: unknown): void {
  port.postMessage({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  } satisfies FileWatcherWorkerMessage)
  port.postMessage({
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
    port.postMessage({
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
        port.postMessage({
          type: 'events',
          events: [{ kind: 'overflow', absolutePath: data.rootPath }]
        } satisfies FileWatcherWorkerMessage)
        return
      }
      void mapWithConcurrency(
        events,
        RUNTIME_FILE_WATCH_STAT_CONCURRENCY,
        async (event): Promise<FsChangeEvent> => {
          let isDirectory = false
          try {
            isDirectory = (await stat(event.path)).isDirectory()
          } catch {
            isDirectory = false
          }
          return { kind: event.type, absolutePath: event.path, isDirectory }
        }
      )
        .then((mapped) => {
          port.postMessage({ type: 'events', events: mapped } satisfies FileWatcherWorkerMessage)
        })
        // Why: without this, a throwing postMessage / stat becomes an unhandled
        // rejection that crashes the worker silently. Surface it instead.
        .catch((err: unknown) => reportWatchError(err))
    },
    { ignore: data.ignore }
  )

  // The crawl finished and the subscription is live.
  port.postMessage({ type: 'ready' } satisfies FileWatcherWorkerMessage)

  port.on('message', (message: FileWatcherHostMessage) => {
    if (message.type === 'unsubscribe') {
      void subscription.unsubscribe().finally(() => {
        port.close()
      })
    }
  })
}

void main().catch((err: unknown) => {
  port.postMessage({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  } satisfies FileWatcherWorkerMessage)
})
