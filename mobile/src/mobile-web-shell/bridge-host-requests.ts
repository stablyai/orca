import { classifyExactGitHubOperation } from '../../../src/shared/github/exact-work-item-operation'
import {
  captureGitHubInvocation,
  requireExactGitHubOperations,
  githubOperationResponse
} from '../transport/github-target-invocation'
import { openRpcRequestBudget } from '../transport/rpc-request-budget'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge/bridge-caps'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { BridgeHostDisposedError } from './bridge-host-errors'
import { isBridgeNativeMethod } from './bridge/bridge-native-verbs'
import { substituteBridgePageClientIdentity } from './bridge/bridge-page-client-identity'

type RequestMessage = Extract<BridgeClientMessage, { type: 'request' }>

// Suppress cancelled requests’ late replies so an id the page abandoned cannot receive an old answer.
type PendingRequest = { live: boolean; retire?: () => void }

export type BridgeHostRequestDeps = {
  client: RpcClient
  isIdTaken: (id: string) => boolean
  sendReply: (id: string, payload: RpcResponse) => void
  sendError: (id: string, error: unknown) => void
  capExceeded: (message: string) => Error
  serveNative: (id: string, method: string, params: unknown) => Promise<RpcResponse>
  readClientIdentity: () => string | null
}

// pending tracks what the page still awaits; inFlight retains uncancellable desktop calls through close/cancel so a replacement document cannot regain their occupied slots.
export class BridgeHostRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private inFlight = 0

  constructor(private readonly deps: BridgeHostRequestDeps) {}

  has(id: string): boolean {
    return this.pending.has(id)
  }

  // sendRequest cannot cancel desktop execution; only suppress its now-unwanted reply.
  cancel(id: string): void {
    const record = this.pending.get(id)
    if (record !== undefined) {
      this.settle(id, record)
    }
  }

  private settle(id: string, record: PendingRequest): boolean {
    if (!record.live) {
      return false
    }
    record.live = false
    record.retire?.()
    this.pending.delete(id)
    return true
  }

  // Replay the exact argument arity for the golden recorder. Fence native requests here; native subscriptions are fenced separately in handleSubscribe.
  private forward(message: RequestMessage, record: PendingRequest): Promise<RpcResponse> {
    const { client } = this.deps
    if (isBridgeNativeMethod(message.method)) {
      return this.deps.serveNative(message.id, message.method, message.params)
    }
    // Replace the page’s identity placeholder on this request path too; failures reach open’s normal refusal catch.
    const params = substituteBridgePageClientIdentity(
      message.params,
      this.deps.readClientIdentity()
    )
    const options =
      message.envelope === undefined
        ? message.options
        : { ...message.options, envelope: message.envelope }
    const bound = classifyExactGitHubOperation(message.method, params, message.envelope)
    if (bound) {
      return this.forwardExact(message, params, record)
    }
    if (options !== undefined) {
      return client.sendRequest(message.method, params, options)
    }
    return 'params' in message
      ? client.sendRequest(message.method, params)
      : client.sendRequest(message.method)
  }

  private async forwardExact(
    message: RequestMessage,
    params: unknown,
    record: PendingRequest
  ): Promise<RpcResponse> {
    const { client } = this.deps
    const invocation = captureGitHubInvocation(
      client,
      () => record.live && this.pending.get(message.id) === record
    )
    record.retire = invocation.retire
    const options = { timeoutMs: 30_000, ...message.options }
    const budget = openRpcRequestBudget(options)
    const remaining = () => {
      if (budget.deadline === null) {
        return options.timeoutMs
      }
      const ms = budget.deadline - Date.now()
      if (ms <= 0) {
        throw new Error('Timed out confirming the executing Orca server.')
      }
      return ms
    }
    try {
      // This is the native first hop, not the final executionHost named by the operation.
      const status = await invocation.status({ ...options, timeoutMs: remaining() })
      requireExactGitHubOperations(status)
      invocation.assertCurrent()
      return githubOperationResponse(
        await client.sendRequest(message.method, params, {
          ...options,
          timeoutMs: remaining(),
          envelope: message.envelope,
          beforeSend: invocation.assertCurrent
        })
      )
    } finally {
      invocation.retire()
    }
  }

  open(message: RequestMessage): void {
    const { id } = message
    // Refuse a colliding newcomer without settling the existing request under that id.
    if (this.pending.has(id) || this.deps.isIdTaken(id)) {
      this.deps.sendError(id, this.deps.capExceeded('that id is already in flight'))
      return
    }
    if (this.inFlight >= BRIDGE_MAX_PENDING_REQUESTS) {
      this.deps.sendError(id, this.deps.capExceeded(`over ${BRIDGE_MAX_PENDING_REQUESTS} requests`))
      return
    }
    const record: PendingRequest = { live: true }
    this.pending.set(id, record)
    let answer: Promise<RpcResponse>
    try {
      answer = this.forward(message, record)
    } catch (error) {
      this.settle(id, record)
      this.deps.sendError(id, error)
      return
    }
    this.inFlight += 1
    void answer.then(
      (payload) => {
        this.inFlight -= 1
        if (this.settle(id, record)) {
          this.deps.sendReply(id, payload)
        }
      },
      (error: unknown) => {
        this.inFlight -= 1
        if (this.settle(id, record)) {
          this.deps.sendError(id, error)
        }
      }
    )
  }

  closeAll(notify: boolean): void {
    for (const [id, record] of this.pending) {
      record.live = false
      record.retire?.()
      // Use delivery-unknown because desktop execution may have happened; definite failure would invite unsafe retry.
      if (notify) {
        this.deps.sendError(id, markRpcDeliveryUnknown(new BridgeHostDisposedError()))
      }
    }
    this.pending.clear()
  }
}
