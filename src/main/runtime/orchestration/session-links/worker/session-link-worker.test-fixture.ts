// The session link worker's real handler behind the same asynchronous message boundary a worker
// thread has, on the test's own database, so tests run the client, queue and SQL without a bundle.
import type { OrchestrationDb } from '../../db/orchestration-db'
import { SessionLinkConnection } from './session-link-operations'
import { bindSessionLinkWorker } from './session-link-worker-client'
import type { SessionLinks, SessionLinkWorkerRequest } from './session-link-worker-protocol'

class InProcessWorker {
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>()

  constructor(private readonly connection: SessionLinkConnection) {}

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
    setImmediate(() => this.emit('exit', 1))
    return 1
  }

  postMessage(request: SessionLinkWorkerRequest): void {
    const response = this.connection.answer(structuredClone(request))
    setImmediate(() => this.emit('message', structuredClone(response)))
  }

  private emit(event: string, arg: unknown): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }
}

/** `db`'s session links answered in process by the worker's handler on `db`'s own connection. */
export function inProcessSessionLinks(db: OrchestrationDb): SessionLinks {
  const connection = new SessionLinkConnection(db.db)
  return bindSessionLinkWorker(db, () => new InProcessWorker(connection))
}
