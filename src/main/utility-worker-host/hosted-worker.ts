import { EventEmitter } from 'node:events'
import { deserialize } from 'node:v8'
import type { Worker } from 'node:worker_threads'
import { unrefTimer } from '../../shared/timers/unref-timer'
import type {
  UtilityWorkerFailure,
  UtilityWorkerPort,
  UtilityWorkerPortEvent,
  UtilityWorkerPortRequest,
  UtilityWorkerSpawn
} from './utility-worker-host-protocol'

/** Fallback when a dead host's port never reports close; each reply still draining restarts it. */
const DRAIN_MS = 5_000

function restoreFailure(failure: UtilityWorkerFailure): Error {
  const error: NodeJS.ErrnoException = new Error(failure.message)
  error.name = failure.name
  if (failure.code) {
    error.code = failure.code
  }
  return error
}

export type HostedWorkerSupervisor = {
  startFailed(error: NodeJS.ErrnoException | undefined): void
  portLost(): void
  outOfMemory(): void
  exited(worker: HostedWorker): void
}

/** Consumer-side stand-in for a worker thread that runs inside a utility process, over its port. */
export class HostedWorker extends EventEmitter {
  private local?: Worker
  private chunks: Uint8Array[] = []
  private exitCode?: number
  private readonly exited = Promise.withResolvers<number>()
  /** Posts a worker hasn't answered yet, replayed if it moves in-process. */
  private unheardPosts: unknown[] = []
  /** The host's process exited; replies it sent first are still on the port until it closes. */
  private draining?: { error: Error; code: number; timer: ReturnType<typeof setTimeout> }
  /** Loaded (or answered): a death now may be real work dying, never a reason to move in-process. */
  heard = false
  terminating = false
  lastReplyType: string | null = null
  receivedBytes = 0

  constructor(
    readonly id: number,
    readonly spawn: UtilityWorkerSpawn,
    private readonly port: UtilityWorkerPort<UtilityWorkerPortEvent>,
    hostName: string,
    private readonly supervisor: HostedWorkerSupervisor
  ) {
    super()
    port.on('message', ({ data }) => this.receive(data))
    // A host that dies takes the port's other end with it, often before main hears of its exit.
    port.on('close', () => {
      if (this.draining) {
        this.failDrained()
      } else if (!this.local && this.exitCode === undefined) {
        this.supervisor.portLost()
        this.fail(new Error(`${hostName} stopped`), 1)
      }
    })
    port.start()
  }

  /** Null while the worker runs in the utility process. */
  get threadId(): number | null {
    return this.local?.threadId ?? null
  }

  postMessage(message: unknown): void {
    if (this.local) {
      this.local.postMessage(message)
    } else if (this.exitCode === undefined) {
      if (!this.heard) {
        this.unheardPosts.push(message)
      }
      this.send({ type: 'post', message })
    }
  }

  ref(): void {
    this.local?.ref()
  }

  unref(): void {
    this.local?.unref()
  }

  terminate(): Promise<number> {
    this.terminating = true
    if (this.local) {
      return this.local.terminate()
    }
    if (this.exitCode === undefined) {
      this.send({ type: 'terminate' })
    }
    return this.exited.promise
  }

  adopt(local: Worker): void {
    this.local = local
    this.port.close()
    local.on('message', (message: unknown) => this.emit('message', message))
    local.on('error', (error) => this.emit('error', error))
    local.once('exit', (code) => this.finish(code))
    for (const message of this.unheardPosts.splice(0)) {
      local.postMessage(message)
    }
  }

  /** The host's death or retirement: one error and one exit, however the news arrives. */
  fail(error: Error, code: number): void {
    if (this.local || this.exitCode !== undefined) {
      return
    }
    if (!this.terminating) {
      this.emit('error', error)
    }
    this.finish(code)
  }

  /** Fails once the port has delivered what the dead host already sent, so finished work isn't lost. */
  failAfterDrain(error: Error, code: number): void {
    if (this.local || this.exitCode !== undefined || this.draining) {
      return
    }
    const timer = setTimeout(() => this.failDrained(), DRAIN_MS)
    unrefTimer(timer)
    this.draining = { error, code, timer }
  }

  private failDrained(): void {
    const draining = this.draining
    if (draining) {
      this.draining = undefined
      clearTimeout(draining.timer)
      this.fail(draining.error, draining.code)
    }
  }

  private send(request: UtilityWorkerPortRequest): void {
    this.port.postMessage(request)
  }

  private receive(event: UtilityWorkerPortEvent): void {
    if (this.local || this.exitCode !== undefined) {
      return
    }
    this.draining?.timer.refresh()
    // Dying unasked before loading: the host decides whether it could not load or ran out of memory.
    if (!this.heard && !this.terminating && (event.type === 'error' || event.type === 'exit')) {
      this.supervisor.startFailed(event.type === 'error' ? restoreFailure(event.error) : undefined)
      return
    }
    if (event.type === 'error' && event.error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
      this.supervisor.outOfMemory()
    }
    this.heard = true
    this.unheardPosts = []
    if (event.type === 'loaded') {
      return
    }
    if (event.type === 'error') {
      // An owner stopping this worker has dropped its listeners; a late error would throw in main.
      if (!this.terminating) {
        this.emit('error', restoreFailure(event.error))
      }
      return
    }
    if (event.type === 'exit') {
      this.finish(event.code)
      return
    }
    this.chunks.push(event.bytes)
    this.receivedBytes += event.bytes.byteLength
    if (event.more) {
      return
    }
    const bytes = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
    this.chunks = []
    let message: unknown
    try {
      message = deserialize(bytes)
    } catch (error) {
      if (!this.terminating) {
        this.emit('error', error)
      }
      return
    }
    this.lastReplyType =
      message &&
      typeof message === 'object' &&
      'type' in message &&
      typeof message.type === 'string'
        ? message.type
        : null
    this.emit('message', message)
  }

  finish(code: number): void {
    if (this.exitCode !== undefined) {
      return
    }
    this.exitCode = code
    this.chunks = []
    clearTimeout(this.draining?.timer)
    this.draining = undefined
    if (!this.local) {
      this.port.close()
    }
    this.supervisor.exited(this)
    this.emit('exit', code)
    this.exited.resolve(code)
  }
}
