import { EventEmitter } from 'node:events'
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
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

// #27362: Windows code-integrity hashing can block CreateProcessW for seconds on the calling loop. Spawn in a worker and fail closed if unavailable (#11161).

// Amortize worker startup across nearby probes while releasing idle isolates promptly.
export const IDLE_TEARDOWN_MS = 15_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'
// Node reports a negative errno as the exit code of a child that never started.
const SPAWN_FAILED_EXIT_CODE = -1

/** False when the child is no longer reachable through a live worker. */
type SendRequest = (request: WorkerThreadChildRequest) => boolean

function toError(payload: WorkerThreadChildErrorPayload): Error {
  const { message, ...fields } = payload
  return Object.assign(new Error(message), fields)
}

/** Error code for a child whose worker died: its pipes closed with the worker, but no close event will arrive. */
export const WORKER_CHILD_ABANDONED_CODE = 'ERR_ORCA_WORKER_CHILD_ABANDONED'

export function isAbandonedWorkerChildError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code === WORKER_CHILD_ABANDONED_CODE
    : false
}

/** The worker forwards stdin pipe failures as child errors; a capture leaves those to the exit status, as main's stdin end does. */
export function isWorkerChildStdinWriteError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'syscall' in error
    ? error.syscall === 'write'
    : false
}

/** Stdin pipe failures reach its 'error' listeners, as on a native pipe; without one they surface as child 'error' events. */
class WorkerThreadChildStdin extends EventEmitter {
  constructor(
    private readonly id: number,
    private readonly send: SendRequest
  ) {
    super()
  }

  write(data: string | Uint8Array): boolean {
    this.send({ type: 'stdin-write', id: this.id, data })
    return true
  }

  end(data?: string | Uint8Array): void {
    if (data !== undefined && data.length > 0) {
      this.write(data)
    }
    this.send({ type: 'stdin-end', id: this.id })
  }
}

/** Main-thread stand-in for a piped ChildProcess whose real process lives on the worker. */
export class WorkerThreadChildProcess extends EventEmitter {
  ownedGroupStopping = false
  ownedGroupTerminated = false
  closed = false
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin: WorkerThreadChildStdin
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(
    readonly id: number,
    private readonly send: SendRequest
  ) {
    super()
    this.stdin = new WorkerThreadChildStdin(id, send)
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.closed) {
      return false
    }
    const exited = this.exitCode !== null || this.signalCode !== null
    // After exit the worker still retires pipes a descendant may hold, as execFile's kill does.
    return this.send({ type: 'kill', id: this.id, signal }) && !exited
  }

  /** The reader is done with one stream, or both; later output stays on the worker instead of crossing to this thread. */
  discardOutput(stream?: 'stdout' | 'stderr'): void {
    if (!this.closed) {
      this.send({ type: 'discard-output', id: this.id, ...(stream ? { stream } : {}) })
    }
  }

  /** Withdraws a launch the worker has not started yet; no effect once it has. */
  cancelPendingSpawn(): void {
    if (!this.closed && this.pid === undefined) {
      this.send({ type: 'cancel-spawn', id: this.id })
    }
  }

  stopOwnedGroup(): void {
    this.ownedGroupStopping = true
    this.send({ type: 'stop-owned-group', id: this.id })
  }

  receive(event: Exclude<WorkerThreadChildEvent, { type: 'ready' }>): void {
    switch (event.type) {
      case 'group-terminated':
        this.ownedGroupTerminated = true
        this.emit('group-terminated')
        return
      case 'spawn':
        this.pid = event.pid
        this.emit('spawn')
        return
      case 'stdout':
      case 'stderr':
        try {
          this[event.type].emit(
            'data',
            Buffer.from(event.chunk.buffer, event.chunk.byteOffset, event.chunk.byteLength)
          )
        } finally {
          this.send({ type: 'output-consumed', id: this.id, bytes: event.chunk.byteLength })
        }
        return
      case 'error':
        if (isWorkerChildStdinWriteError(event.error) && this.stdin.listenerCount('error') > 0) {
          this.stdin.emit('error', toError(event.error))
          return
        }
        this.emitErrorIfObserved(event.error)
        return
      case 'spawn-error':
        this.emit('group-terminated')
        this.emitErrorIfObserved(event.error)
        this.receive({ type: 'exit', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        this.receive({ type: 'close', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        return
      case 'exit':
        this.exitCode = event.code
        this.signalCode = event.signal
        this.emit('exit', event.code, event.signal)
        return
      case 'close':
        this.closed = true
        this.emit('close', event.code, event.signal)
    }
  }

  // Ignore unobserved late errors after caller detach or EventEmitter would throw fatally into main.
  private emitErrorIfObserved(payload: WorkerThreadChildErrorPayload): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', toError(payload))
    }
  }
}

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
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
      isIdle: () => this.children.size === 0,
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
      if (this.children.size === 0) {
        this.host.scheduleIdleTeardown()
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
    if (this.children.size === 0) {
      this.host.scheduleIdleTeardown()
    }
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
    this.host.destroy()
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

/** True when a spawn now would reach a live worker; callers that must not fail can spawn locally instead. */
export function canSpawnOnWorkerThread(): boolean {
  return shared().available()
}
