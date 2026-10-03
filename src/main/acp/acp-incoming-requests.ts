import { AcpRpcError } from './acp-errors'
import type { AcpJsonRpcMessage, AcpPeerHandlers } from './acp-json-rpc-peer'

type OpenRequest = { controller: AbortController; abandon: () => void }

export class AcpIncomingRequests {
  private readonly open = new Map<string | number | null, OpenRequest>()

  constructor(
    private readonly handler: AcpPeerHandlers['onRequest'],
    private readonly send: (message: AcpJsonRpcMessage) => Promise<void>,
    private readonly onFailure: (error: Error) => void,
    private readonly capacity: number,
    private readonly timeoutMs: number
  ) {}

  close(error: Error): void {
    for (const request of this.open.values()) {
      request.controller.abort(error)
      request.abandon()
    }
    this.open.clear()
  }

  handle(id: string | number | null, method: string, params: unknown): void {
    if (this.open.has(id) || this.open.size >= this.capacity) {
      void this.sendError(
        id,
        new AcpRpcError(-32600, 'Duplicate request id or incoming request capacity exceeded')
      )
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abandon = (): void => {}
    const deadline = new Promise<never>((_resolve, reject) => {
      abandon = () => reject(controller.signal.reason)
      timer = setTimeout(
        () => reject(new AcpRpcError(-32001, `ACP client request timed out: ${method}`)),
        this.timeoutMs
      )
    })
    this.open.set(id, { controller, abandon })
    const retire = (): void => {
      clearTimeout(timer)
      if (this.open.get(id)?.controller === controller) {
        this.open.delete(id)
      }
    }
    void Promise.race([
      deadline,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) {
          return undefined
        }
        return this.handler?.(method, params, { id, signal: controller.signal })
      })
    ])
      .then(async (result) => {
        if (controller.signal.aborted) {
          return
        }
        if (result === undefined) {
          throw new AcpRpcError(-32601, `Unknown ACP client method: ${method}`)
        }
        // The agent may reuse the id as soon as it reads the response.
        retire()
        await this.send({ jsonrpc: '2.0', id, result })
      })
      .catch(async (error) => {
        if (controller.signal.aborted) {
          return
        }
        retire()
        await this.sendError(
          id,
          error instanceof AcpRpcError
            ? error
            : new AcpRpcError(-32603, error instanceof Error ? error.message : String(error))
        )
      })
      .finally(() => {
        retire()
        controller.abort()
      })
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
