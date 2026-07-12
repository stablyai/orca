// Host side of the out-of-process @parcel/watcher (see
// parcel-watcher-process-entry.ts). Why: native watcher teardown races
// fail-fast the hosting process (issue #7547), so local subscriptions live in
// a disposable forked child; when it crashes the host respawns it and
// resubscribes every live root, and callers are told via onInterruption so
// they can refresh state that changed during the gap.
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type * as ParcelWatcher from '@parcel/watcher'
import { getWatcherProcessEntryPath } from './parcel-watcher-entry-path'
import type {
  HostToWatcherMessage,
  WatcherProcessEvent,
  WatcherProcessSubscribeOptions,
  WatcherToHostMessage
} from './parcel-watcher-process-entry'

export type { WatcherProcessEvent, WatcherProcessSubscribeOptions }

export type WatcherProcessCallback = (err: Error | null, events: WatcherProcessEvent[]) => void
export type WatcherProcessSubscription = { unsubscribe(): Promise<void> }

// Why: a crash loop (e.g. a root that faults the native watcher on every
// resubscribe) must degrade to "file watching disabled" rather than fork-bomb.
const CRASH_WINDOW_MS = 30_000
const MAX_CRASHES_PER_WINDOW = 3

type SubscriptionRecord = {
  id: number
  dir: string
  opts: WatcherProcessSubscribeOptions
  callback: WatcherProcessCallback
  onInterruption?: () => void
  pendingSubscribe?: { resolve: () => void; reject: (err: Error) => void }
}

let child: ChildProcess | null = null
let nextSubscriptionId = 1
let crashTimes: number[] = []
let shutdownRequested = false
let loggedInProcessFallback = false
const records = new Map<number, SubscriptionRecord>()
const pendingUnsubscribes = new Map<number, () => void>()

function shouldRunInProcess(entryPath: string): boolean {
  // Why: vitest suites mock '@parcel/watcher' at the module level; a forked
  // child would bypass those mocks (and could execute a stale build output),
  // so tests keep the historical in-process path.
  if (process.env.VITEST) {
    return true
  }
  if (existsSync(entryPath)) {
    return false
  }
  if (!loggedInProcessFallback) {
    loggedInProcessFallback = true
    console.warn(
      `[parcel-watcher-process] entry not found at ${entryPath}; using in-process watcher (no crash isolation)`
    )
  }
  return true
}

async function subscribeInProcess(
  dir: string,
  callback: WatcherProcessCallback,
  opts: WatcherProcessSubscribeOptions
): Promise<WatcherProcessSubscription> {
  const watcher = await import('@parcel/watcher')
  const subscription = await watcher.subscribe(
    dir,
    callback as ParcelWatcher.SubscribeCallback,
    opts as ParcelWatcher.Options
  )
  return { unsubscribe: () => subscription.unsubscribe() }
}

function inCrashCooldown(): boolean {
  const now = Date.now()
  crashTimes = crashTimes.filter((time) => now - time < CRASH_WINDOW_MS)
  return crashTimes.length >= MAX_CRASHES_PER_WINDOW
}

function sendToChild(proc: ChildProcess, message: HostToWatcherMessage): void {
  try {
    proc.send(message)
  } catch {
    // Channel already closed — the child's exit handler recovers.
  }
}

function ensureWatcherProcess(): ChildProcess | null {
  if (shutdownRequested) {
    return null
  }
  if (child?.connected) {
    return child
  }
  if (inCrashCooldown()) {
    return null
  }
  let proc: ChildProcess
  try {
    proc = fork(getWatcherProcessEntryPath(), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
  } catch (err) {
    console.error('[parcel-watcher-process] failed to fork watcher process:', err)
    return null
  }
  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error('[parcel-watcher-process]', String(chunk).trimEnd())
  })
  proc.on('message', (message) => {
    if (child === proc) {
      handleChildMessage(message as WatcherToHostMessage)
    }
  })
  proc.on('error', () => handleChildGone(proc))
  proc.on('exit', (code, signal) => {
    if (child === proc && (code !== 0 || signal)) {
      console.error(
        `[parcel-watcher-process] watcher process exited (code=${code}, signal=${signal})`
      )
    }
    handleChildGone(proc)
  })
  child = proc
  return proc
}

function handleChildMessage(message: WatcherToHostMessage): void {
  if (!message || typeof message !== 'object') {
    return
  }
  if (message.op === 'unsubscribed') {
    const resolve = pendingUnsubscribes.get(message.id)
    pendingUnsubscribes.delete(message.id)
    resolve?.()
    return
  }
  const record = records.get(message.id)
  if (!record) {
    return
  }
  if (message.op === 'subscribed') {
    const pending = record.pendingSubscribe
    record.pendingSubscribe = undefined
    if (pending) {
      pending.resolve()
    } else {
      // Reached after a crash-respawn resubscribe: events emitted while the
      // watcher process was down are lost, so let the caller refresh.
      record.onInterruption?.()
    }
    return
  }
  if (message.op === 'subscribe-failed') {
    records.delete(message.id)
    const pending = record.pendingSubscribe
    record.pendingSubscribe = undefined
    if (pending) {
      pending.reject(new Error(message.message))
    } else {
      record.callback(new Error(message.message), [])
    }
    // Why: a failed last subscribe empties the records map without any
    // unsubscribe ever being called — tear down the idle child here too.
    killWatcherChildIfIdle()
    return
  }
  if (message.op === 'events') {
    record.callback(null, message.events)
    return
  }
  if (message.op === 'watch-error') {
    record.callback(new Error(message.message), [])
  }
}

function failAllSubscriptions(err: Error): void {
  for (const record of records.values()) {
    const pending = record.pendingSubscribe
    record.pendingSubscribe = undefined
    if (pending) {
      pending.reject(err)
    } else {
      record.callback(err, [])
    }
  }
  records.clear()
}

function handleChildGone(proc: ChildProcess): void {
  if (child !== proc) {
    return
  }
  child = null
  // Why: process death released every native handle, so a pending unsubscribe
  // is complete by definition — resolve rather than hang worktree deletion.
  for (const resolve of pendingUnsubscribes.values()) {
    resolve()
  }
  pendingUnsubscribes.clear()
  if (shutdownRequested || records.size === 0) {
    return
  }
  crashTimes.push(Date.now())
  const replacement = ensureWatcherProcess()
  if (!replacement) {
    console.error(
      '[parcel-watcher-process] watcher process crashed repeatedly; disabling file watching'
    )
    failAllSubscriptions(new Error('file watcher process crashed repeatedly'))
    return
  }
  console.error(
    `[parcel-watcher-process] watcher process crashed; resubscribing ${records.size} root(s)`
  )
  for (const record of records.values()) {
    sendToChild(replacement, {
      op: 'subscribe',
      id: record.id,
      dir: record.dir,
      opts: record.opts
    })
  }
}

// Why: the last record gone leaves the child idle until app shutdown. Killing
// it releases native handles without running watcher.node's crash-prone async
// teardown (same rationale as disposeWatcherProcess) and reclaims the process;
// the next subscribe forks a fresh child. `child = null` before kill so the
// exit event neither counts as a crash nor respawns. Process death also
// completes any still-pending unsubscribe acks.
function killWatcherChildIfIdle(): void {
  const proc = child
  if (!proc || records.size > 0) {
    return
  }
  child = null
  for (const resolve of pendingUnsubscribes.values()) {
    resolve()
  }
  pendingUnsubscribes.clear()
  proc.kill()
}

function makeSubscription(record: SubscriptionRecord): WatcherProcessSubscription {
  return {
    unsubscribe: (): Promise<void> => {
      if (!records.delete(record.id)) {
        return Promise.resolve()
      }
      const proc = child
      if (!proc?.connected) {
        return Promise.resolve()
      }
      if (records.size === 0) {
        killWatcherChildIfIdle()
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        pendingUnsubscribes.set(record.id, resolve)
        sendToChild(proc, { op: 'unsubscribe', id: record.id })
      })
    }
  }
}

/** Subscribe to a directory tree via the isolated watcher process. Falls back
 *  to an in-process @parcel/watcher subscription when the forked entry is not
 *  available (tests, unbuilt trees). `onInterruption` fires after the watcher
 *  process crashed and this subscription was transparently re-established —
 *  events in the gap were lost, so callers should refresh. */
export function subscribeViaWatcherProcess(
  dir: string,
  callback: WatcherProcessCallback,
  opts: WatcherProcessSubscribeOptions,
  onInterruption?: () => void
): Promise<WatcherProcessSubscription> {
  if (shouldRunInProcess(getWatcherProcessEntryPath())) {
    return subscribeInProcess(dir, callback, opts)
  }
  const record: SubscriptionRecord = {
    id: nextSubscriptionId++,
    dir,
    opts,
    callback,
    onInterruption
  }
  return new Promise((resolve, reject) => {
    const proc = ensureWatcherProcess()
    if (!proc) {
      reject(new Error('file watcher process unavailable'))
      return
    }
    records.set(record.id, record)
    record.pendingSubscribe = {
      resolve: () => resolve(makeSubscription(record)),
      reject
    }
    sendToChild(proc, { op: 'subscribe', id: record.id, dir, opts })
  })
}

/** Kill the watcher process at app shutdown. Process death releases native
 *  handles without running watcher.node's crash-prone async teardown. */
export function disposeWatcherProcess(): void {
  shutdownRequested = true
  const proc = child
  child = null
  for (const resolve of pendingUnsubscribes.values()) {
    resolve()
  }
  pendingUnsubscribes.clear()
  records.clear()
  proc?.kill()
}

export function resetWatcherProcessForTest(): void {
  disposeWatcherProcess()
  shutdownRequested = false
  crashTimes = []
  loggedInProcessFallback = false
  nextSubscriptionId = 1
}
