import type { Worker } from 'node:worker_threads'
import { assertWslNotLatchedAbsent } from '@orca/process-host/wsl-not-installed-latch'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { LazyWorkerThreadHost } from '../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../worker-threads/worker-thread-transport'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import type {
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec,
  WorkerThreadProviderOwnerSpec
} from './worker-thread-child-process-protocol'
import {
  isWorkerChildStdinWriteError,
  toWorkerChildError,
  WorkerThreadChildProcess
} from './worker-thread-child-stdin'

export { isWorkerChildStdinWriteError, WorkerThreadChildProcess }

// #27362: Windows code-integrity hashing can block CreateProcessW for seconds on the calling loop. Spawn in a worker and fail closed if unavailable (#11161).

// Amortize worker startup across nearby probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'

/** Error code for a child whose worker died: its pipes closed with the worker, but no close event will arrive. */
export const WORKER_CHILD_ABANDONED_CODE = 'ERR_ORCA_WORKER_CHILD_ABANDONED'

export function isAbandonedWorkerChildError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code === WORKER_CHILD_ABANDONED_CODE
    : false
}

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
  private readonly providerOwners = new Map<
    number,
    { resolve: (result: { pid: number }) => void; reject: (error: Error) => void }
  >()
  // Detached provider owners whose uv_process_t lives on this worker; keep the worker alive until they exit so they are reaped.
  private readonly liveProviderOwners = new Set<number>()
  private nextId = 1
  private workerAnswered = false
  private workerError: string | null = null
  // A worker that dies before answering anything is broken here (e.g. an unloadable chunk); stop offering it.
  private failedToStart = false
  // Settles true on the current worker's 'ready', false if it exits first.
  private ready: { promise: Promise<boolean>; settle: (ready: boolean) => void } | null = null

  constructor(factory: WorkerThreadFactory) {
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (event) => this.route(event),
      // A worker error can arrive ahead of messages it already posted; its exit comes after them, so decide there.
      onError: (error) => {
        this.workerError ??= error.message
      },
      onExit: (code) =>
        this.abandonAll(
          this.workerError === null
            ? `Child process worker exited with code ${code}`
            : `Child process worker failed: ${this.workerError}`
        ),
      isIdle: () =>
        this.children.size === 0 &&
        this.providerOwners.size === 0 &&
        this.liveProviderOwners.size === 0,
      onUnavailable: (error) =>
        console.warn(
          `[worker-thread-child-process] worker unavailable. ${error instanceof Error ? error.message : String(error)}`
        )
    })
  }

  /** Starts or reuses the worker; false while it cannot run, including during an idle retirement or after it failed to start. */
  available(): boolean {
    return this.ensureWorker()
  }

  /** True once the worker has loaded its entry; false if it can't start or dies first. */
  whenReady(): Promise<boolean> {
    return this.ensureWorker() && this.ready ? this.ready.promise : Promise.resolve(false)
  }

  /** Starts a cold worker without waiting; its first message is 'ready', so having answered means loaded. */
  isReady(): boolean {
    return this.ensureWorker() && this.workerAnswered
  }

  private ensureWorker(): boolean {
    // A worker that died before answering is not started again; direct spawns report it unavailable.
    if (this.failedToStart) {
      return false
    }
    if (!this.host.current) {
      // A fresh worker (first use or after idle teardown) has not proven it starts yet.
      this.workerAnswered = false
      this.workerError = null
      this.ready?.settle(false)
      const ready = Promise.withResolvers<boolean>()
      this.ready = { promise: ready.promise, settle: ready.resolve }
    }
    return this.host.ensure() !== null
  }

  spawn(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
    const id = this.nextId++
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request))
    if (this.ensureWorker()) {
      this.host.clearIdleTimer()
      this.children.set(id, child)
      if (this.post({ type: 'spawn', id, spec })) {
        return child
      }
      this.forget(id)
    }
    // Deferred like Node's own spawn errors, so the caller can attach listeners first.
    process.nextTick(() =>
      child.receive({
        type: 'spawn-error',
        id,
        error: { message: 'Child process worker is unavailable' }
      })
    )
    return child
  }

  spawnProviderOwner(spec: WorkerThreadProviderOwnerSpec): Promise<{ pid: number }> {
    const id = this.nextId++
    if (!this.ensureWorker()) {
      return Promise.reject(new Error('Child process worker is unavailable'))
    }
    this.host.clearIdleTimer()
    return new Promise<{ pid: number }>((resolve, reject) => {
      this.providerOwners.set(id, { resolve, reject })
      const worker = this.host.current
      try {
        if (!worker) {
          throw new Error('Child process worker is unavailable')
        }
        worker.postMessage({ type: 'spawn-provider-owner', id, spec })
      } catch (error) {
        this.providerOwners.delete(id)
        this.scheduleIdleIfEmpty()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private scheduleIdleIfEmpty(): void {
    if (
      this.children.size === 0 &&
      this.providerOwners.size === 0 &&
      this.liveProviderOwners.size === 0
    ) {
      this.host.scheduleIdleTeardown()
    }
  }

  private post(request: WorkerThreadChildRequest): boolean {
    const worker = this.host.current
    if (!worker || !this.children.has(request.id)) {
      return false
    }
    try {
      worker.postMessage(request)
      return true
    } catch {
      return false
    }
  }

  private route(event: WorkerThreadChildEvent): void {
    this.workerAnswered = true
    if (event.type === 'ready') {
      this.ready?.settle(true)
      // Every launch that started this worker may have been cancelled while it loaded.
      this.scheduleIdleIfEmpty()
      return
    }
    if (event.type === 'provider-owner-exit') {
      this.liveProviderOwners.delete(event.id)
      this.scheduleIdleIfEmpty()
      return
    }
    if (event.type === 'provider-owner-spawned' || event.type === 'provider-owner-error') {
      const pending = this.providerOwners.get(event.id)
      this.providerOwners.delete(event.id)
      if (event.type === 'provider-owner-spawned') {
        this.liveProviderOwners.add(event.id)
      }
      this.scheduleIdleIfEmpty()
      if (pending) {
        if (event.type === 'provider-owner-spawned') {
          pending.resolve({ pid: event.pid })
        } else {
          pending.reject(toWorkerChildError(event.error))
        }
      }
      return
    }
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    child.receive(event)
    if (event.type === 'close' && event.retained) {
      this.post({ type: 'release', id: event.id })
    }
    if (
      event.type === 'spawn-error' ||
      (child.closed && (!child.ownedGroupStopping || child.ownedGroupTerminated))
    ) {
      this.forget(event.id)
    }
  }

  private forget(id: number): void {
    this.children.delete(id)
    this.scheduleIdleIfEmpty()
  }

  // Worker death closes stdin for graceful stop but proves no child exit; omit close so drain windows/home locks still expire normally.
  private abandonAll(message: string): void {
    this.ready?.settle(false)
    if (!this.workerAnswered && !this.failedToStart) {
      this.failedToStart = true
      console.warn(`[worker-thread-child-process] worker died before answering. ${message}`)
    }
    this.workerAnswered = false
    this.workerError = null
    const abandoned = [...this.children.values()]
    this.children.clear()
    const abandonedOwners = [...this.providerOwners.values()]
    this.providerOwners.clear()
    this.liveProviderOwners.clear()
    this.host.destroy()
    for (const owner of abandonedOwners) {
      owner.reject(Object.assign(new Error(message), { code: WORKER_CHILD_ABANDONED_CODE }))
    }
    // The worker posts a pid in the turn it creates the process and its messages arrive before 'exit',
    // so a child without one was never created (queued, or the worker was not ready): it fails to start.
    for (const child of abandoned) {
      child.receive({
        type: child.pid === undefined ? 'spawn-error' : 'error',
        id: child.id,
        error: { message, code: WORKER_CHILD_ABANDONED_CODE }
      })
    }
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // A missing entry surfaces as the worker's own error before it answers, which retires the host (failedToStart).
  return spawnWorkerThread(workerPath, { name: 'orca-child-process-spawner' })
}

let sharedHost: WorkerThreadChildProcessHost | null = null
const shared = (): WorkerThreadChildProcessHost =>
  (sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory))
const workerDisabled = (): boolean => process.env.ORCA_CHILD_PROCESS_WORKER_DISABLED === '1'

export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  // The worker has its own module state, so only main knows WSL was proven absent.
  assertWslNotLatchedAbsent(spec.program)
  return shared().spawn(spec)
}

/** Resolves true once a spawn would reach a worker that loaded its entry; false means spawn locally. */
export function whenSpawnWorkerReady(): Promise<boolean> {
  return workerDisabled() ? Promise.resolve(false) : shared().whenReady()
}

/** Never waits: false while the worker boots (the boot starts), so the caller spawns locally meanwhile. */
export function spawnWorkerReadyNow(): boolean {
  return !workerDisabled() && shared().isReady()
}

export function spawnProviderOwnerOnWorkerThread(
  spec: WorkerThreadProviderOwnerSpec
): Promise<{ pid: number }> {
  return shared().spawnProviderOwner(spec)
}

/** True when a spawn now would reach a live worker; callers that must not fail can spawn locally instead. */
export function canSpawnOnWorkerThread(): boolean {
  return shared().available()
}
