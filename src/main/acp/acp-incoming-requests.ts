import { AcpRpcError } from './acp-errors'
import type { AcpJsonRpcMessage, AcpPeerHandlers } from './acp-json-rpc-peer'

type OpenRequest = {
  controller: AbortController
  abandon: () => void
  closed: boolean
  cancelled: boolean
}

export class AcpIncomingRequests {
  private readonly open = new Map<string | number | null, OpenRequest>()

  constructor(
    private readonly handler: AcpPeerHandlers['onRequest'],
    private readonly send: (message: AcpJsonRpcMessage) => Promise<void>,
    private readonly onFailure: (error: Error) => void,
    private readonly capacity: number,
    private readonly diagnose: (message: string) => void
  ) {}

  close(error: Error): void {
    for (const request of this.open.values()) {
      request.closed = true
      request.controller.abort(error)
      request.abandon()
    }
    this.open.clear()
  }

  // Each handler answers its own request (a permission answers `cancelled`); -32800 only if it
  // throws. The runtime never answers for a live handler: an answer still being saved must win.
  cancel(): void {
    for (const request of this.open.values()) {
      if (!request.cancelled) {
        request.cancelled = true
        request.controller.abort(new AcpRpcError(-32800, 'Request cancelled'))
      }
    }
  }

  handle(id: string | number | null, method: string, params: unknown): void {
    if (this.open.has(id)) {
      this.diagnose('Ignored duplicate ACP incoming request id')
      return
    }
    if (this.open.size >= this.capacity) {
      this.refuse(id, new AcpRpcError(-32603, 'ACP incoming request capacity exceeded'))
      return
    }
    const controller = new AbortController()
    let abandon = (): void => {}
    const abandoned = new Promise<never>((_resolve, reject) => {
      abandon = () => reject(controller.signal.reason)
    })
    const request: OpenRequest = { controller, abandon, closed: false, cancelled: false }
    this.open.set(id, request)
    const retire = (): void => {
      if (this.open.get(id) === request) {
        this.open.delete(id)
      }
    }
    void Promise.race([
      abandoned,
      Promise.resolve().then(() => {
        // A cancelled request still reaches its handler, so a permission can answer `cancelled`.
        if (request.closed) {
          throw controller.signal.reason
        }
        if (!this.handler) {
          throw new AcpRpcError(-32601, `Unknown ACP client method: ${method}`)
        }
        return this.handler(method, params, { id, signal: controller.signal })
      })
    ])
      .then(async (result) => {
        if (request.closed) {
          return
        }
        // The agent may reuse the id as soon as it reads the response.
        retire()
        await this.send({ jsonrpc: '2.0', id, result: result ?? null })
      })
      .catch(async (error) => {
        if (request.closed) {
          return
        }
        retire()
        await this.sendError(
          id,
          request.cancelled
            ? new AcpRpcError(-32800, 'Request cancelled')
            : error instanceof AcpRpcError
              ? error
              : new AcpRpcError(-32603, error instanceof Error ? error.message : String(error))
        )
      })
      .finally(() => {
        retire()
        controller.abort()
      })
  }

  refuse(id: string | number | null, error: AcpRpcError): void {
    void this.sendError(id, error)
  }

  private async sendError(id: string | number | null, error: AcpRpcError): Promise<void> {
    try {
      await this.send({
        jsonrpc: '2.0',
        id,
        error: { code: error.code, message: error.message, data: error.data }
      })
    } catch (failure) {
      this.onFailure(failure instanceof Error ? failure : new Error(String(failure)))
    }
  }
}
