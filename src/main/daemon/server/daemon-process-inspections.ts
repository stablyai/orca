import type { Socket } from 'node:net'
import {
  inspectProcessOptions,
  type InspectProcessRequest
} from '../protocol/daemon-foreground-process-protocol'
import type { TerminalHost } from '../terminal-host/terminal-host'

export class DaemonProcessInspections {
  private readonly pendingBySocket = new WeakMap<
    Socket,
    { requests: Map<string, AbortController>; onClose: () => void }
  >()

  constructor(private readonly host: TerminalHost) {}

  async inspect(socket: Socket | undefined, request: InspectProcessRequest) {
    const { id, payload } = request
    const options = inspectProcessOptions(payload)
    if (!socket || options.runningWorkSinceMs === undefined) {
      return Object.keys(options).length > 0
        ? this.host.inspectProcess(payload.sessionId, options)
        : this.host.inspectProcess(payload.sessionId)
    }
    let pending = this.pendingBySocket.get(socket)
    if (!pending) {
      const requests = new Map<string, AbortController>()
      const onClose = (): void => {
        for (const controller of requests.values()) {
          controller.abort()
        }
      }
      pending = { requests, onClose }
      this.pendingBySocket.set(socket, pending)
      socket.once('close', onClose)
    }
    if (pending.requests.has(id)) {
      throw new Error('Process inspection is already in flight')
    }
    const controller = new AbortController()
    pending.requests.set(id, controller)
    try {
      return await this.host.inspectProcess(payload.sessionId, {
        ...options,
        signal: controller.signal
      })
    } finally {
      pending.requests.delete(id)
      if (pending.requests.size === 0) {
        socket.off('close', pending.onClose)
        this.pendingBySocket.delete(socket)
      }
    }
  }

  cancel(socket: Socket | undefined, requestId: string): void {
    if (socket) {
      this.pendingBySocket.get(socket)?.requests.get(requestId)?.abort()
    }
  }
}
