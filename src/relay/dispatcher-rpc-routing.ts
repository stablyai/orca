import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../shared/timer-delay'
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  SkillInstallFailureSchema
} from '../shared/skill-install-failure'
import {
  TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
  TerminalUnavailableCauseSchema
} from '../shared/terminal-unavailable-cause'
import {
  RelayErrorCode,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './protocol'
import {
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES,
  type SinkWriteSettlement
} from './dispatcher-client-writer'
import {
  RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS,
  RESPONSE_OVER_CAPACITY_MESSAGE,
  type RelayClient,
  type RequestContext
} from './dispatcher-contract'
import { RelayDispatcherFrameCodec } from './dispatcher-frame-codec'

export abstract class RelayDispatcherRpcRouting extends RelayDispatcherFrameCodec {
  requestPrimary(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) {
    return this.requestClient(this.primaryClient.id, method, params, options)
  }

  requestAnyClient(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; excludeClientId?: number }
  ): Promise<unknown> {
    const candidates = Array.from(this.clients.values()).filter(
      (client) => !client.closed && client.id !== options?.excludeClientId
    )
    // Why: prefer a real socket client over the synthetic primary so requests don't forward to a dead stdout.
    const target = candidates.find((client) => client !== this.primaryClient) ?? candidates[0]
    if (!target) {
      return Promise.reject(new Error('No owning Orca client is connected to the relay'))
    }
    return this.requestClient(target.id, method, params, options)
  }

  protected handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRelayRequests.get(msg.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pendingRelayRequests.delete(msg.id)
    if (msg.error) {
      const error = new Error(msg.error.message) as Error & { code?: number; data?: unknown }
      error.code = msg.error.code
      error.data = msg.error.data
      pending.reject(error)
      return
    }
    pending.resolve(msg.result)
  }

  protected async handleRequest(client: RelayClient, req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method)
    if (!handler) {
      this.sendResponse(client, req.id, undefined, {
        code: -32601,
        message: `Method not found: ${req.method}`
      })
      return
    }

    // Why: snapshot generation before the await to detect if the client disconnected mid-flight.
    const gen = client.generation
    const { key: abortKey, controller: abortController } = this.requestAborts.create(
      client.id,
      req.id
    )
    const responseSettledHandlers = new Set<(result: SinkWriteSettlement) => void>()
    let responseSettled = false
    const settleResponse = (result: SinkWriteSettlement): void => {
      if (responseSettled) {
        return
      }
      responseSettled = true
      for (const callback of responseSettledHandlers) {
        try {
          callback(result)
        } catch (err) {
          process.stderr.write(
            `[relay] Response settlement callback failed: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
      }
      responseSettledHandlers.clear()
      this.requestAborts.delete(abortKey)
    }
    const context: RequestContext = {
      clientId: client.id,
      isStale: () =>
        client.generation !== gen || !this.clients.has(client.id) || abortController.signal.aborted,
      signal: abortController.signal,
      sessionIdentity: client.sessionIdentity,
      onResponseSettled: (handler) => {
        if (responseSettled) {
          throw new Error('Response settlement callback registered after settlement')
        }
        responseSettledHandlers.add(handler)
      }
    }
    try {
      const result = await handler(req.params ?? {}, context)
      if (context.isStale()) {
        settleResponse({ ok: false, error: new Error('Relay request became stale') })
        return
      }
      const accepted = this.sendResponse(client, req.id, result, undefined, (settlement) => {
        settleResponse(
          context.isStale()
            ? { ok: false, error: new Error('Relay request became stale') }
            : settlement
        )
      })
      if (!accepted) {
        settleResponse({ ok: false, error: new Error('Relay response was not admitted') })
      }
    } catch (err) {
      if (context.isStale()) {
        settleResponse({ ok: false, error: new Error('Relay request became stale') })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const errorCode = (err as { code?: unknown }).code
      const code = typeof errorCode === 'number' ? errorCode : -32000
      // Why an allowlist keyed on the error code: error `data` is otherwise dropped, so a
      // handler cannot leak internals by attaching them. Each published shape is validated
      // against its own schema before it crosses.
      const structured =
        errorCode === SKILL_INSTALL_RPC_ERROR_CODE
          ? SkillInstallFailureSchema.safeParse((err as { data?: unknown }).data)
          : errorCode === TERMINAL_UNAVAILABLE_RPC_ERROR_CODE
            ? TerminalUnavailableCauseSchema.safeParse((err as { data?: unknown }).data)
            : null
      const data = structured?.success === true ? structured.data : undefined
      const accepted = this.sendResponse(
        client,
        req.id,
        undefined,
        { code, message, ...(data === undefined ? {} : { data }) },
        (result) => {
          settleResponse({
            ok: false,
            error: result.ok ? new Error(message) : result.error
          })
        }
      )
      if (!accepted) {
        settleResponse({ ok: false, error: new Error('Relay error response was not admitted') })
      }
    }
  }

  protected handleNotification(client: RelayClient, notif: JsonRpcNotification): void {
    if (notif.method === 'rpc.cancel') {
      const id = Number((notif.params ?? {}).id)
      const controller = this.requestAborts.get(client.id, id)
      controller?.abort()
      return
    }
    const handler = this.notificationHandlers.get(notif.method)
    if (handler) {
      const gen = client.generation
      handler(notif.params ?? {}, {
        clientId: client.id,
        isStale: () => client.generation !== gen || !this.clients.has(client.id),
        sessionIdentity: client.sessionIdentity,
        onResponseSettled: () => {
          throw new Error('Notifications do not have response publication fences')
        }
      })
    }
  }

  protected sendResponse(
    client: RelayClient,
    id: number,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const msg: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null })
    }
    const frame = this.prepareFrame(msg)
    const lane =
      frame.frameBytes > DISPATCHER_CONTROL_QUEUE_MAX_BYTES ? 'legacy-response' : 'control'
    // Why 'reject': the control lane is a shared budget, so a reply that fits the 1 MiB ceiling alone
    // still overflows it under concurrent traffic. Fatal admission would close the connection — every
    // pane on the host — over one listing. A response is the droppable class of control frame: it
    // carries an id, so the substitute below tells that one caller, and pty.replay/notifyControl keep
    // the fatal default because a silent drop there desyncs the client with nothing to retry.
    const accepted = this.enqueuePreparedFrame(client, frame, lane, onSettled, 'reject')
    if (accepted) {
      return true
    }
    // Why: an oversized response must fail its own request; closing would kill every pane on the host.
    // A rejected first enqueue leaves onSettled untouched, so exactly one settlement happens.
    return this.enqueuePreparedFrame(
      client,
      this.prepareFrame({
        jsonrpc: '2.0',
        id,
        error: {
          code: RelayErrorCode.ResponseOverCapacity,
          message: RESPONSE_OVER_CAPACITY_MESSAGE
        }
      }),
      'control',
      // Why: writing the substitute is not delivering the result — a settlement fence must never read
      // the capacity error's successful write as "the peer received your result".
      (settlement) =>
        onSettled(
          settlement.ok
            ? { ok: false, error: new Error(RESPONSE_OVER_CAPACITY_MESSAGE) }
            : settlement
        ),
      // Why 'reject': if even ~150 bytes will not fit, the caller's own request timeout settles it.
      // Closing to report that one request failed is the outcome this whole path exists to avoid.
      'reject'
    )
  }

  private requestClient(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const client = this.clients.get(clientId)
    if (this.disposed || !client || client.closed) {
      return Promise.reject(new Error('Relay client is not connected'))
    }
    const timeoutMs = options?.timeoutMs ?? RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS
    if (!isSafeTimerDelayMs(timeoutMs)) {
      return Promise.reject(
        new Error(`Request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms`)
      )
    }
    const id = this.nextRequestId++
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRelayRequests.delete(id)
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingRelayRequests.set(id, { resolve, reject, timer })
      if (!this.enqueueFrame(client, msg, 'control', () => {}, 'reject')) {
        clearTimeout(timer)
        this.pendingRelayRequests.delete(id)
        reject(new Error(`Request "${method}" exceeded the relay control transport capacity`))
      }
    })
  }
}
