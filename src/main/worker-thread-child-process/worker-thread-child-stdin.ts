import { EventEmitter } from 'node:events'
import type {
  WorkerThreadChildErrorPayload,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

/** False when the child is no longer reachable through a live worker. */
export type SendWorkerChildRequest = (request: WorkerThreadChildRequest) => boolean

export function toWorkerChildError(payload: WorkerThreadChildErrorPayload): Error {
  const { message, ...fields } = payload
  return Object.assign(new Error(message), fields)
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
