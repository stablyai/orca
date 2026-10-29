import { EventEmitter } from 'node:events'
import type { Serializable } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest,
  WorkerThreadChildSpec,
  WorkerThreadForkSpec
} from './worker-thread-child-process-protocol'

// #27362: Windows code-integrity hashing can block CreateProcessW for seconds on the calling loop. Spawn in a worker and fail closed if unavailable (#11161).

// Amortize worker startup across nearby probes.
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
  connected = true
  private nextSendId = 1
  private readonly sends = new Map<number, (error: Error | null) => void>()
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin: WorkerThreadChildStdin
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(
    readonly id: number,
    private readonly sendRequest: SendRequest
  ) {
    super()
    this.stdin = new WorkerThreadChildStdin(id, sendRequest)
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false
    }
    return this.sendRequest({ type: 'kill', id: this.id, signal })
  }

  send(message: Serializable, callback?: (error: Error | null) => void): boolean {
    const sendId = this.nextSendId++
    if (callback) {
      this.sends.set(sendId, callback)
    }
    if (this.connected && this.sendRequest({ type: 'ipc-send', id: this.id, sendId, message })) {
      return true
    }
    this.sends.delete(sendId)
    process.nextTick(() => callback?.(new Error('Child process worker is unavailable')))
    return false
  }

  receive(event: WorkerThreadChildEvent): void {
    switch (event.type) {
      case 'ipc-message':
        this.emit('message', event.message)
        return
      case 'ipc-sent': {
        const callback = this.sends.get(event.sendId)
        this.sends.delete(event.sendId)
        callback?.(event.error ? toError(event.error) : null)
        return
      }
      case 'disconnect':
        this.connected = false
        this.failPendingSends()
        this.emit('disconnect')
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
          this.sendRequest({ type: 'output-consumed', id: this.id, bytes: event.chunk.byteLength })
        }
        return
      case 'error':
        if (!this.connected) {
          this.failPendingSends()
        }
        this.emitErrorIfObserved(event.error)
        return
      case 'spawn-error':
        this.emitErrorIfObserved(event.error)
        this.receive({ type: 'exit', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        this.receive({ type: 'close', id: this.id, code: SPAWN_FAILED_EXIT_CODE, signal: null })
        return
      case 'exit':
        this.connected = false
        this.failPendingSends()
        this.exitCode = event.code
        this.signalCode = event.signal
        this.emit('exit', event.code, event.signal)
        return
      case 'close':
        this.emit('close', event.code, event.signal)
    }
  }

  private failPendingSends(): void {
    const callbacks = [...this.sends.values()]
    this.sends.clear()
    for (const callback of callbacks) {
      callback(new Error('Child process IPC is unavailable'))
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

  constructor(
    private readonly factory: WorkerThreadFactory,
    idleTeardownMs = IDLE_TEARDOWN_MS
  ) {
    this.host = new LazyWorkerThreadHost<WorkerThreadChildEvent>({
      factory,
      idleTeardownMs,
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
    return this.start({ type: 'spawn', id: this.nextId++, spec })
  }

  fork(spec: WorkerThreadForkSpec): WorkerThreadChildProcess {
    // A blocked fork must not stall an established sibling's IPC, kill, or exit delivery.
    const isolated = new WorkerThreadChildProcessHost(this.factory, 0)
    return isolated.start({ type: 'fork', id: 1, spec })
  }

  private start(
    request: Extract<WorkerThreadChildRequest, { type: 'spawn' | 'fork' }>
  ): WorkerThreadChildProcess {
    const { id } = request
    const child = new WorkerThreadChildProcess(id, (request) => this.post(request))
    if (this.host.ensure()) {
      this.host.clearIdleTimer()
      this.children.set(id, child)
      if (this.post(request)) {
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

  // Worker death closes stdin for graceful stop but proves no child exit; omit close so drain windows/home locks still expire normally.
  private abandonAll(message: string): void {
    const abandoned = [...this.children.values()]
    this.children.clear()
    this.host.destroy()
    for (const child of abandoned) {
      child.connected = false
      child.receive({ type: 'error', id: child.id, error: { message } })
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
  return new Worker(workerPath)
}

let sharedHost: WorkerThreadChildProcessHost | null = null
let sharedForkHost: WorkerThreadChildProcessHost | null = null

export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec): WorkerThreadChildProcess {
  sharedHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedHost.spawn(spec)
}

export function forkProcessOnWorkerThread(spec: WorkerThreadForkSpec): WorkerThreadChildProcess {
  sharedForkHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory)
  return sharedForkHost.fork(spec)
}
