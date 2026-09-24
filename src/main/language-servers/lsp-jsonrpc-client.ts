// Hand-written minimal LSP JSON-RPC client core (spec D2). Transport-agnostic:
// the caller owns the process (or test double) and wires stdout chunks into
// `feed()` while giving us a `send` callback. The clangd-specific protocol
// semantics (initialize shape, server-request answers, document table) live in
// clangd-session.ts — this module only speaks JSON-RPC + Content-Length.
import { createLspFrameParser, encodeLspMessage } from '../../shared/lsp-content-length-framer'

export type LspJsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type LspClientHandlers = {
  /** Server notification (no id). `$/…` methods arrive here like any other. */
  onServerNotification: (method: string, params: unknown) => void
  /**
   * Server -> client request. MUST be answered: clangd stalls when
   * `window/workDoneProgress/create` goes unanswered (spike findings §5).
   * The returned value becomes the response result (null when undefined).
   */
  onServerRequest: (method: string, params: unknown) => unknown
  /** Framing/protocol violations — the caller kills the session. */
  onProtocolError: (error: Error) => void
}

export type LspJsonRpcClient = {
  /** Feed one stdout chunk; frames are parsed and dispatched synchronously. */
  feed(chunk: Buffer): void
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  notify(method: string, params?: unknown): void
  /** Answer a server request seen through onServerRequest. */
  respond(id: number | string, result: unknown): void
  respondWithError(id: number | string, code: number, message: string): void
  /** Terminal: rejects every pending request and refuses further traffic. */
  die(reason: string): void
  readonly dead: boolean
}

export class LspRequestError extends Error {
  constructor(
    method: string,
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(`LSP ${method} error ${code}: ${message}`)
    this.name = 'LspRequestError'
  }
}

export class LspClientDiedError extends Error {
  constructor(reason: string) {
    super(`LSP session died: ${reason}`)
    this.name = 'LspClientDiedError'
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function createLspJsonRpcClient(
  send: (bytes: Buffer) => void,
  handlers: LspClientHandlers
): LspJsonRpcClient {
  let nextRequestId = 1
  let died: Error | null = null
  const pending = new Map<
    number | string,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  const parser = createLspFrameParser(
    (message) => dispatchFrame(message),
    (error) => handlers.onProtocolError(error)
  )

  function dispatchFrame(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      handlers.onProtocolError(new Error('LSP frame is not a JSON object'))
      return
    }
    const frame = message as LspJsonRpcMessage
    if (frame.method !== undefined) {
      if (frame.id !== undefined) {
        void answerServerRequest(frame)
      } else {
        handlers.onServerNotification(frame.method, frame.params)
      }
      return
    }
    if (frame.id !== undefined) {
      const entry = pending.get(frame.id)
      if (!entry) {
        handlers.onProtocolError(new Error(`LSP response for unknown request id ${frame.id}`))
        return
      }
      pending.delete(frame.id)
      if (frame.error) {
        entry.reject(
          new LspRequestError(entry.method, frame.error.code, frame.error.message, frame.error.data)
        )
      } else {
        entry.resolve(frame.result)
      }
    }
  }

  async function answerServerRequest(frame: LspJsonRpcMessage): Promise<void> {
    let result: unknown
    try {
      result = await handlers.onServerRequest(frame.method as string, frame.params)
    } catch (error) {
      respondWithError(
        frame.id as number | string,
        -32603,
        error instanceof Error ? error.message : String(error)
      )
      return
    }
    respond(frame.id as number | string, result ?? null)
  }

  function write(message: LspJsonRpcMessage): void {
    if (died) {
      throw died
    }
    send(encodeLspMessage(message))
  }

  function respond(id: number | string, result: unknown): void {
    if (died) {
      return
    }
    try {
      write({ jsonrpc: '2.0', id, result })
    } catch {
      // Dying anyway; the pending reap happens on exit observation.
    }
  }

  function respondWithError(id: number | string, code: number, message: string): void {
    if (died) {
      return
    }
    try {
      write({ jsonrpc: '2.0', id, error: { code, message } })
    } catch {
      // Dying anyway.
    }
  }

  return {
    feed(chunk: Buffer): void {
      parser.feed(chunk)
    },
    request(
      method: string,
      params?: unknown,
      options: { timeoutMs?: number } = {}
    ): Promise<unknown> {
      if (died) {
        return Promise.reject(died)
      }
      const id = nextRequestId++
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`LSP ${method} exceeded ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, {
          method,
          resolve: (value: unknown) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error: Error) => {
            clearTimeout(timer)
            reject(error)
          }
        })
        try {
          write(
            params === undefined
              ? { jsonrpc: '2.0', id, method }
              : { jsonrpc: '2.0', id, method, params }
          )
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    notify(method: string, params?: unknown): void {
      if (died) {
        return
      }
      try {
        write(
          params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
        )
      } catch {
        // Fire-and-forget; the next request surfaces a dead peer.
      }
    },
    respond,
    respondWithError,
    die(reason: string): void {
      if (died) {
        return
      }
      died = new LspClientDiedError(reason)
      for (const entry of pending.values()) {
        entry.reject(died)
      }
      pending.clear()
    },
    get dead(): boolean {
      return died !== null
    }
  }
}
