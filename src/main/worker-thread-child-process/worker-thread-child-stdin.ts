import { EventEmitter } from 'node:events'
import { WorkerThreadChildOutput } from './worker-thread-child-output'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildEvent,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

// Node reports a negative errno as the exit code of a child that never started.
const SPAWN_FAILED_EXIT_CODE = -1

/** False when the child is no longer reachable through a live worker. */
export type SendWorkerChildRequest = (request: WorkerThreadChildRequest) => boolean

export function toWorkerChildError(payload: WorkerThreadChildErrorPayload): Error {
  const { message, ...fields } = payload
  return Object.assign(new Error(message), fields)
}

/** The worker forwards stdin pipe failures as child errors; a capture leaves those to the exit status, as main's stdin end does. */
export function isWorkerChildStdinWriteError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'syscall' in error
    ? error.syscall === 'write'
    : false
}

/** Stdin pipe failures reach its 'error' listeners, as on a native pipe; without one they surface as child 'error' events. */
export class WorkerThreadChildStdin extends EventEmitter {
  constructor(
    private readonly id: number,
    private readonly send: SendWorkerChildRequest
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
  ownedGroupStopUnverified = false
  closed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin: WorkerThreadChildStdin
  readonly stdout = new WorkerThreadChildOutput()
  readonly stderr = new WorkerThreadChildOutput()
  // Not an own property until spawn: an own undefined pid means a failed Node spawn, but this child learns its pid late and is killed by id.
  declare pid: number | undefined

  constructor(
    readonly id: number,
    private readonly send: SendWorkerChildRequest
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

  stopOwnedGroup(): boolean {
    this.ownedGroupStopping = true
    return this.send({ type: 'stop-owned-group', id: this.id })
  }

  receive(
    event: Exclude<
      WorkerThreadChildEvent,
      { type: 'ready' | 'provider-owner-spawned' | 'provider-owner-exit' | 'provider-owner-error' }
    >
  ): void {
    switch (event.type) {
      case 'group-terminated':
        this.ownedGroupTerminated = true
        this.emit('group-terminated')
        return
      case 'group-stop-unverified':
        this.ownedGroupStopUnverified = true
        this.emit('group-stop-unverified')
        return
      case 'spawn':
        this.pid = event.pid
        this.emit('spawn')
        return
      case 'stdout':
      case 'stderr':
        try {
          this[event.type].push(
            Buffer.from(event.chunk.buffer, event.chunk.byteOffset, event.chunk.byteLength)
          )
        } finally {
          this.send({ type: 'output-consumed', id: this.id, bytes: event.chunk.byteLength })
        }
        return
      case 'error':
        // Node reports a child it could not create (ENOENT) as an error before any spawn; mark it as Node does.
        if (this.pid === undefined && event.error.syscall?.startsWith('spawn')) {
          this.pid = undefined
        }
        if (isWorkerChildStdinWriteError(event.error) && this.stdin.listenerCount('error') > 0) {
          this.stdin.emit('error', toWorkerChildError(event.error))
          return
        }
        this.emitErrorIfObserved(event.error)
        return
      case 'spawn-error':
        // An own undefined pid marks a failed spawn, as on a Node child, before callers see the error.
        this.pid = undefined
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
        this.stdout.flush()
        this.stderr.flush()
        this.emit('close', event.code, event.signal)
    }
  }

  // Ignore unobserved late errors after caller detach or EventEmitter would throw fatally into main.
  private emitErrorIfObserved(payload: WorkerThreadChildErrorPayload): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', toWorkerChildError(payload))
    }
  }
}
