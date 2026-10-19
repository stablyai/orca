import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec
} from './worker-thread-child-process-protocol'

// Why (#27362): libuv creates processes inline on the calling loop, and on
// Windows CreateProcessW can spend seconds in code integrity hashing a large,
// uncached binary. Spawning from a worker thread keeps that off the UI loop.
// Like the port-scan worker (#11161) this fails closed rather than spawning
// in-process when no worker can be started.

// Starting a worker costs a few ms; a few minutes covers back-to-back probes.
export const IDLE_TEARDOWN_MS = 2 * 60_000

const WORKER_ENTRY_FILENAME = 'worker-thread-child-process-entry.js'
// Node reports a negative errno as the exit code of a child that never started.
const SPAWN_FAILED_EXIT_CODE = -1

/** False when the child is no longer reachable through a live worker. */
type SendRequest = (request: WorkerThreadChildRequest) => boolean

function toError(payload: WorkerThreadChildErrorPayload): Error {
  const error: NodeJS.ErrnoException = new Error(payload.message)
  if (payload.code) {
    error.code = payload.code
  }
  return error
}

// Never emits: the worker reports stdin failures as child 'error' events.
class WorkerThreadChildStdin extends EventEmitter {
  constructor(
    private readonly id: number,
    private readonly send: SendRequest
  ) {
    super()
  }

  write(data: string): boolean {
    this.send({ type: 'stdin-write', id: this.id, data })
    return true
  }

  end(): void {
    this.send({ type: 'stdin-end', id: this.id })
  }
}

/** Main-thread stand-in for a piped ChildProcess whose real process lives on the worker. */
export class WorkerThreadChildProcess extends EventEmitter {
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

  receive(event: WorkerThreadChildEvent): void {
    switch (event.type) {
      case 'spawn':
        this.pid = event.pid
        this.emit('spawn')
        return
      case 'stdout':
      case 'stderr':
        this[event.type].emit(
          'data',
          Buffer.from(event.chunk.buffer, event.chunk.byteOffset, event.chunk.byteLength)
        )
        return
      case 'error':
        this.emitErrorIfObserved(event.error)
        return
      case 'spawn-error':
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
        this.emit('close', event.code, event.signal)
    }
  }

  // Why: a late error after the caller detached would otherwise throw inside the
  // worker message handler and surface as an uncaught main-process exception.
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

  spawn(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
    const id = this.nextId++
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request))
    if (this.host.ensure()) {
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
    const child = this.children.get(event.id)
    if (!child) {
      return
    }
    if (event.type === 'close' || event.type === 'spawn-error') {
      this.forget(event.id)
    }
    child.receive(event)
  }

  private forget(id: number): void {
    this.children.delete(id)
    if (this.children.size === 0) {
      this.host.scheduleIdleTeardown()
    }
  }

  // Why no 'close': the worker's death closes each child's stdin, which is its
  // graceful stop, but nothing here can observe the exit, so callers' drain
  // windows (and the Codex home lock they hold) still run their course.
  private abandonAll(message: string): void {
    const abandoned = [...this.children.values()]
    this.children.clear()
    this.host.destroy()
    for (const child of abandoned) {
      child.receive({ type: 'error', id: child.id, error: { message } })
    }
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // Why: throw synchronously so spawn() fails closed instead of waiting on a worker that never loads.
  if (!existsSync(workerPath)) {
    throw new Error(`Child process worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedHost: WorkerThreadChildProcessHost | null = null

/** Spawns a piped child from the shared worker thread so process creation never blocks the main loop. */
export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost.spawn(spec)
}
