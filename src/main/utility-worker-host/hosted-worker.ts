import { EventEmitter } from 'node:events'
import { deserialize } from 'node:v8'
import type { Worker } from 'node:worker_threads'
import type {
  UtilityWorkerFailure,
  UtilityWorkerHostEvent,
  UtilityWorkerHostRequest,
  UtilityWorkerSpawn
} from './utility-worker-host-protocol'

function restoreFailure(failure: UtilityWorkerFailure): Error {
  const error: NodeJS.ErrnoException = new Error(failure.message)
  error.name = failure.name
  if (failure.code) {
    error.code = failure.code
  }
  return error
}

/** Main-side stand-in for a worker thread that runs inside the utility process. */
export class HostedWorker extends EventEmitter {
  private local?: Worker
  private chunks: Uint8Array[] = []
  private exitCode?: number
  private readonly exited = Promise.withResolvers<number>()
  /** Posts a worker hasn't answered yet, replayed if it moves in-process. */
  private unheardPosts: unknown[] = []
  /** A worker that has said nothing yet can still move in-process unnoticed. */
  heard = false
  terminating = false
  lastReplyType: string | null = null
  receivedBytes = 0

  constructor(
    readonly id: number,
    readonly spawn: UtilityWorkerSpawn,
    private readonly send: (request: UtilityWorkerHostRequest) => void
  ) {
    super()
  }

  postMessage(message: unknown): void {
    if (this.local) {
      this.local.postMessage(message)
    } else if (this.exitCode === undefined) {
      if (!this.heard) {
        this.unheardPosts.push(message)
      }
      this.send({ type: 'post', id: this.id, message })
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
      this.send({ type: 'terminate', id: this.id })
    }
    return this.exited.promise
  }

  adopt(local: Worker): void {
    this.local = local
    local.on('message', (message: unknown) => this.emit('message', message))
    local.on('error', (error) => this.emit('error', error))
    local.once('exit', (code) => this.finish(code))
    for (const message of this.unheardPosts.splice(0)) {
      local.postMessage(message)
    }
  }

  receive(event: Exclude<UtilityWorkerHostEvent, { type: 'ready' }>): void {
    this.heard = true
    this.unheardPosts = []
    if (event.type === 'error') {
      this.emit('error', restoreFailure(event.error))
    } else if (event.type === 'exit') {
      this.finish(event.code)
    } else {
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
        this.emit('error', error)
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
  }

  finish(code: number): void {
    if (this.exitCode !== undefined) {
      return
    }
    this.exitCode = code
    this.chunks = []
    this.emit('exit', code)
    this.exited.resolve(code)
  }
}
