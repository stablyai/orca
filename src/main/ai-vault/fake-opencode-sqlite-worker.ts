import type { Worker } from 'node:worker_threads'
import type { OpenCodeSqliteWorkerRequest } from './session-scanner-opencode-sqlite-worker-protocol'

export class FakeOpenCodeSqliteWorker {
  postedRequests: OpenCodeSqliteWorkerRequest[] = []
  postMessageError: Error | null = null
  terminated = false
  unrefed = false
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

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

  unref(): void {
    this.unrefed = true
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: OpenCodeSqliteWorkerRequest): void {
    if (this.postMessageError) {
      const error = this.postMessageError
      this.postMessageError = null
      throw error
    }
    this.postedRequests.push(request)
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  lastId(): number {
    const last = this.postedRequests.at(-1)
    if (!last) {
      throw new Error('no request posted to fake worker')
    }
    return last.id
  }

  listenerCount(): number {
    return Array.from(this.listeners.values()).reduce(
      (total, listeners) => total + listeners.size,
      0
    )
  }
}

export function makeFakeOpenCodeSqliteWorkerFactory(
  workers: FakeOpenCodeSqliteWorker[]
): () => Worker {
  return () => {
    const worker = new FakeOpenCodeSqliteWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
}
