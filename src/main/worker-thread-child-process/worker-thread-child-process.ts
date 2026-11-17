import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { Worker } from 'node:worker_threads'
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

// Amortize worker startup across nearby probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'
// Node reports a negative errno as the exit code of a child that never started.
const SPAWN_FAILED_EXIT_CODE = -1
const WORKER_PID_WAIT_MS = 5_000

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

// Never emits: the worker reports stdin failures as child 'error' events.
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
    if (data !== undefined) {
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
  abandoned = false
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
    if (this.exitCode !== null || this.signalCode !== null) {
      return false
    }
    return this.send({ type: 'kill', id: this.id, signal })
  }

  stopOwnedGroup(): void {
    this.ownedGroupStopping = true
    this.send({ type: 'stop-owned-group', id: this.id })
  }

  receive(event: WorkerThreadChildEvent): void {
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
        if (isAbandonedWorkerChildError(event.error)) {
          this.abandoned = true
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

/** Keep a late spawn subscribed: killing the root before a tree walk would orphan descendants. */
export function runOnceWorkerReportsPid(
  child: WorkerThreadChildProcess,
  action: () => Promise<boolean>
): Promise<boolean> {
  if (child.abandoned) {
    return Promise.resolve(false)
  }
  if (child.pid) {
    return action()
  }
  // A close the worker reported before any PID means the process never started: nothing is left to stop.
  if (child.closed) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const settle = (result: boolean): void => {
      clearTimeout(timer)
      resolve(result)
    }
    const detach = (): void => {
      child.off('spawn', onSpawn)
      child.off('close', onClose)
      child.off('error', onError)
    }
    const onSpawn = (): void => {
      detach()
      clearTimeout(timer)
      try {
        void action().then(settle, () => settle(false))
      } catch {
        settle(false)
      }
    }
    const onClose = (): void => {
      detach()
      settle(true)
    }
    const onError = (error: Error): void => {
      if (isAbandonedWorkerChildError(error)) {
        detach()
        settle(false)
      }
    }
    const timer = setTimeout(() => settle(false), WORKER_PID_WAIT_MS)
    timer.unref?.()
    child.on('spawn', onSpawn)
    child.on('close', onClose)
    child.on('error', onError)
  })
}

export class WorkerThreadChildProcessHost {
  private readonly host: LazyWorkerThreadHost<WorkerThreadChildEvent>
  private readonly children = new Map<number, WorkerThreadChildProcess>()
  private nextId = 1
  private workerAnswered = false
  // A worker that dies before answering anything is broken here (e.g. an unloadable chunk); stop offering it.
  private failedToStart = false

  constructor(factory: WorkerThreadFactory) {
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (event) => this.route(event),
      onError: (error) => this.abandonAll(`Child process worker failed: ${error.message}`),
      onExit: (code) => this.abandonAll(`Child process worker exited with code ${code}`),
      isIdle: () => this.children.size === 0,
      onUnavailable: (error) =>
        console.warn(
          `[worker-thread-child-process] worker unavailable. ${error instanceof Error ? error.message : String(error)}`
        )
    })
  }

  /** Starts or reuses the worker; false while it cannot run, including during an idle retirement or after it failed to start. */
  available(): boolean {
    return !this.failedToStart && this.ensureWorker()
  }

  private ensureWorker(): boolean {
    if (!this.host.current) {
      // A fresh worker (first use or after idle teardown) has not proven it starts yet.
      this.workerAnswered = false
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
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    child.receive(event)
    if (event.type === 'close') {
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
    if (!this.workerAnswered && this.children.size > 0 && !this.failedToStart) {
      this.failedToStart = true
      console.warn(`[worker-thread-child-process] worker died before answering. ${message}`)
    }
    this.workerAnswered = false
    const abandoned = [...this.children.values()]
    this.children.clear()
    this.host.destroy()
    for (const child of abandoned) {
      child.receive({
        type: 'error',
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
  // Reject missing worker synchronously so spawning fails closed instead of awaiting impossible readiness.
  if (!existsSync(workerPath)) {
    throw new Error(`Child process worker entry not found: ${workerPath}`)
  }
  return spawnWorkerThread(workerPath)
}

let sharedHost: WorkerThreadChildProcessHost | null = null

export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost.spawn(spec)
}

/** True when a spawn now would reach a live worker; callers that must not fail can spawn locally instead. */
export function canSpawnOnWorkerThread(): boolean {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost.available()
}
