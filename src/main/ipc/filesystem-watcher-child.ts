import type * as ParcelWatcher from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent } from '../../shared/types'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'
import {
  coalesceWatcherEvents,
  mapWatcherEventsToFsChangeEvents
} from './filesystem-watcher-event-normalization'

type FilesystemWatcherChildData = {
  rootPath: string
  ignore: string[]
}

type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

export type FilesystemWatcherChildMessage =
  | { type: 'ready' }
  | { type: 'events'; events: FsChangeEvent[] }
  | { type: 'error'; message: string }

export type FilesystemWatcherHostMessage = { type: 'unsubscribe' }

const FILESYSTEM_WATCHER_CHILD_DATA_ENV = 'ORCA_FILESYSTEM_WATCHER_CHILD_DATA'

const DEBOUNCE_TRAILING_MS = 150
const DEBOUNCE_MAX_WAIT_MS = 500

function readChildData(): FilesystemWatcherChildData {
  const raw = process.env[FILESYSTEM_WATCHER_CHILD_DATA_ENV]
  if (!raw) {
    throw new Error(`Missing ${FILESYSTEM_WATCHER_CHILD_DATA_ENV}`)
  }
  return JSON.parse(raw) as FilesystemWatcherChildData
}

const data = readChildData()
const batch: DebouncedBatch = {
  events: [],
  overflowed: false,
  timer: null,
  firstEventAt: 0
}
let hostDisconnected = false
let disposeSubscription: (() => void) | undefined

process.once('disconnect', () => {
  hostDisconnected = true
  disposeSubscription?.()
})

function postToHost(message: FilesystemWatcherChildMessage): void {
  process.send?.(message)
}

function closeHostChannel(): void {
  process.disconnect?.()
}

function reportOverflow(): void {
  postToHost({
    type: 'events',
    events: [{ kind: 'overflow', absolutePath: data.rootPath }]
  })
}

async function flushBatch(): Promise<void> {
  const overflowed = batch.overflowed
  const rawEvents = batch.events.splice(0)
  batch.overflowed = false
  batch.timer = null
  batch.firstEventAt = 0

  if (rawEvents.length === 0 && !overflowed) {
    return
  }

  if (overflowed || rawEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
    reportOverflow()
    return
  }

  const events = await mapWatcherEventsToFsChangeEvents(coalesceWatcherEvents(rawEvents))
  postToHost({ type: 'events', events })
}

function scheduleBatchFlush(): void {
  const now = Date.now()

  if (batch.firstEventAt === 0) {
    batch.firstEventAt = now
  }

  if (now - batch.firstEventAt >= DEBOUNCE_MAX_WAIT_MS) {
    if (batch.timer) {
      clearTimeout(batch.timer)
    }
    void flushBatch()
    return
  }

  if (batch.timer) {
    clearTimeout(batch.timer)
  }
  batch.timer = setTimeout(() => void flushBatch(), DEBOUNCE_TRAILING_MS)
}

function reportWatchError(err: unknown): void {
  postToHost({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  })
  reportOverflow()
}

async function main(): Promise<void> {
  let watcher: typeof ParcelWatcher
  try {
    watcher = await import('@parcel/watcher')
  } catch (err) {
    postToHost({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
    return
  }

  const subscription = await watcher.subscribe(
    data.rootPath,
    (err, events) => {
      if (err) {
        reportWatchError(err)
        return
      }
      queueWatcherEvents(batch, events)
      scheduleBatchFlush()
    },
    { ignore: data.ignore }
  )

  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    if (batch.timer) {
      clearTimeout(batch.timer)
    }
    void subscription.unsubscribe().finally(() => {
      closeHostChannel()
    })
  }
  disposeSubscription = dispose

  if (hostDisconnected) {
    dispose()
    return
  }

  postToHost({ type: 'ready' })

  process.on('message', (message) => {
    if ((message as FilesystemWatcherHostMessage).type === 'unsubscribe') {
      dispose()
    }
  })
}

void main().catch((err: unknown) => {
  postToHost({
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  })
})
