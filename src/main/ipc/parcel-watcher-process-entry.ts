// Forked (ELECTRON_RUN_AS_NODE) child that hosts all local @parcel/watcher
// subscriptions. Why: watcher.node has native teardown races that fail-fast
// the hosting process (issue #7547, 0xc0000409 on Windows; same class as
// #5377/#6635). Running the native module here turns a watcher fault into a
// contained child crash the host can recover from, instead of killing the app
// and every agent session in it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ParcelWatcher from '@parcel/watcher'

export type WatcherProcessEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type WatcherProcessSubscribeOptions = {
  ignore?: string[]
  backend?: string
}

export type HostToWatcherMessage =
  | { op: 'subscribe'; id: number; dir: string; opts: WatcherProcessSubscribeOptions }
  | { op: 'unsubscribe'; id: number }

export type WatcherToHostMessage =
  | { op: 'subscribed'; id: number }
  | { op: 'subscribe-failed'; id: number; message: string }
  | { op: 'events'; id: number; events: WatcherProcessEvent[] }
  | { op: 'watch-error'; id: number; message: string }
  | { op: 'unsubscribed'; id: number }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Canary self-check. Why: @parcel/watcher can wedge silently — a lock-order
// inversion between Debounce::notify (debounce mutex → watcher mutex) and
// Watcher teardown (watcher mutex → debounce mutex in ~Watcher) deadlocks the
// single process-wide debounce thread, after which every subscription still
// acks but no events are ever delivered. The canary watches a private temp
// dir and touches a file in it; consecutive missed deliveries mean event
// delivery is dead, so exit and let the host respawn a fresh process.
const CANARY_INTERVAL_MS = 10_000
const CANARY_EVENT_TIMEOUT_MS = 5_000
const CANARY_MAX_MISSES = 2

async function startCanary(hasLiveSubscriptions: () => boolean): Promise<void> {
  let canaryDir: string
  let lastEventAt = 0
  try {
    canaryDir = mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
    const watcher = await import('@parcel/watcher')
    // Why: pin the Windows backend like the main subscriptions do, so the
    // canary never probes for Watchman.
    const opts = (
      process.platform === 'win32' ? { backend: 'windows' } : {}
    ) as ParcelWatcher.Options
    await watcher.subscribe(
      canaryDir,
      (err) => {
        if (!err) {
          lastEventAt = Date.now()
        }
      },
      opts
    )
  } catch (err) {
    process.stderr.write(`[parcel-watcher-process] canary unavailable: ${errorMessage(err)}\n`)
    return
  }
  process.on('exit', () => {
    try {
      rmSync(canaryDir, { recursive: true, force: true })
    } catch {
      // Temp dir cleanup is best-effort.
    }
  })

  let misses = 0
  setInterval(() => {
    // An idle watcher process can't wedge anything visible; only probe while
    // roots are subscribed so an idle child doesn't restart pointlessly.
    if (!hasLiveSubscriptions()) {
      misses = 0
      return
    }
    const probedAt = Date.now()
    try {
      writeFileSync(join(canaryDir, 'canary.txt'), String(probedAt))
    } catch {
      return
    }
    setTimeout(() => {
      if (lastEventAt >= probedAt) {
        misses = 0
        return
      }
      misses++
      if (misses >= CANARY_MAX_MISSES) {
        process.stderr.write(
          '[parcel-watcher-process] event delivery wedged (canary starved); restarting watcher process\n'
        )
        process.exit(2)
      }
    }, CANARY_EVENT_TIMEOUT_MS)
  }, CANARY_INTERVAL_MS)
}

function main(): void {
  const send = (message: WatcherToHostMessage): void => {
    try {
      process.send?.(message)
    } catch {
      // Host is gone; the disconnect handler below exits this process.
    }
  }

  // Subscribe promises are kept (not just subscriptions) so an unsubscribe
  // that races a still-crawling subscribe awaits it instead of leaking the
  // native handle — on Windows a leaked handle keeps the worktree dir locked.
  const subscriptions = new Map<number, Promise<ParcelWatcher.AsyncSubscription | null>>()

  const handleSubscribe = async (
    id: number,
    dir: string,
    opts: WatcherProcessSubscribeOptions
  ): Promise<ParcelWatcher.AsyncSubscription | null> => {
    try {
      const watcher = await import('@parcel/watcher')
      const subscription = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            send({ op: 'watch-error', id, message: errorMessage(err) })
            return
          }
          if (events.length > 0) {
            send({
              op: 'events',
              id,
              events: events.map((event) => ({ type: event.type, path: event.path }))
            })
          }
        },
        opts as ParcelWatcher.Options
      )
      send({ op: 'subscribed', id })
      return subscription
    } catch (err) {
      subscriptions.delete(id)
      send({ op: 'subscribe-failed', id, message: errorMessage(err) })
      return null
    }
  }

  const handleUnsubscribe = async (id: number): Promise<void> => {
    const pending = subscriptions.get(id)
    subscriptions.delete(id)
    try {
      const subscription = await pending
      await subscription?.unsubscribe()
    } catch (err) {
      process.stderr.write(
        `[parcel-watcher-process] unsubscribe ${id} failed: ${errorMessage(err)}\n`
      )
    }
    send({ op: 'unsubscribed', id })
  }

  process.on('message', (message: HostToWatcherMessage) => {
    if (!message || typeof message !== 'object') {
      return
    }
    if (message.op === 'subscribe') {
      subscriptions.set(message.id, handleSubscribe(message.id, message.dir, message.opts))
      return
    }
    if (message.op === 'unsubscribe') {
      void handleUnsubscribe(message.id)
    }
  })

  void startCanary(() => subscriptions.size > 0)

  // Why: if the host dies (or kills us during shutdown), exit immediately —
  // process death releases every native watcher handle without running the
  // crash-prone napi teardown at all.
  process.on('disconnect', () => {
    process.exit(0)
  })
}

main()
