// A worker's real request handler behind the same asynchronous message boundary a worker thread
// has, so tests run the client, queue and handler without building the worker bundle.
import type { Worker } from 'node:worker_threads'
import type { WorkerThreadFactory } from './worker-thread-transport'

export type InProcessWorkerControls<TRequest> = {
  /** Workers spawned so far. */
  spawned: number
  /** The worker exits (as a crash) on matching requests instead of answering. */
  crashesOn: (request: TRequest) => boolean
  /** The worker never answers matching requests. */
  hangsOn: (request: TRequest) => boolean
}

class InProcessWorker<TRequest> {
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>()
  private exited = false

  constructor(
    private readonly handle: (request: TRequest) => unknown,
    private readonly controls: InProcessWorkerControls<TRequest>
  ) {}

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.exit(1)
    return 1
  }

  postMessage(request: TRequest): void {
    if (this.controls.crashesOn(request)) {
      this.exit(1)
    } else if (!this.controls.hangsOn(request)) {
      setImmediate(() => this.emit('message', this.handle(request)))
    }
  }

  private exit(code: number): void {
    if (!this.exited) {
      this.exited = true
      setImmediate(() => this.emit('exit', code))
    }
  }

  private emit(event: string, arg: unknown): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }
}

export function inProcessWorker<TRequest>(handle: (request: TRequest) => unknown): {
  factory: WorkerThreadFactory
  controls: InProcessWorkerControls<TRequest>
} {
  const controls: InProcessWorkerControls<TRequest> = {
    spawned: 0,
    crashesOn: () => false,
    hangsOn: () => false
  }
  const factory = () => {
    controls.spawned++
    const worker = new InProcessWorker(handle, controls)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: InProcessWorker implements every Worker member the request queue's host touches (on/off/removeAllListeners/unref/terminate/postMessage); the rest is never reached.
    return worker as unknown as Worker
  }
  return { factory, controls }
}
