// The bots DB worker's real request handler behind the same asynchronous message boundary a worker
// thread has, so tests run the client, queue and SQL without building the worker bundle.
import type { Worker } from 'node:worker_threads'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import { handleBotsDbRequest } from './bots-db-worker-entry'
import type { BotsDbWorkerRequest } from './bots-db-worker-protocol'

export type InProcessWorkerControls = {
  /** Workers spawned so far. */
  spawned: number
  /** The worker exits (as a crash) on these ops instead of answering. */
  crashOn: Set<string>
  /** The worker never answers these ops. */
  hangOn: Set<string>
}

class InProcessWorker {
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>()
  private exited = false

  constructor(private readonly controls: InProcessWorkerControls) {}

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

  postMessage(request: BotsDbWorkerRequest): void {
    if (this.controls.crashOn.has(request.op)) {
      this.exit(1)
    } else if (!this.controls.hangOn.has(request.op)) {
      setImmediate(() => this.emit('message', handleBotsDbRequest(request)))
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

export function inProcessBotsDbWorker(): {
  factory: WorkerThreadFactory
  controls: InProcessWorkerControls
} {
  const controls: InProcessWorkerControls = { spawned: 0, crashOn: new Set(), hangOn: new Set() }
  const factory = () => {
    controls.spawned++
    const worker = new InProcessWorker(controls)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: InProcessWorker implements every Worker member the request queue's host touches (on/off/removeAllListeners/unref/terminate/postMessage); the rest is never reached.
    return worker as unknown as Worker
  }
  return { factory, controls }
}
