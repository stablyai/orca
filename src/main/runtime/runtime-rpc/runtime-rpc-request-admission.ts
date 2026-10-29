import type { RuntimeMetadata } from '../../../shared/runtime-bootstrap'
import { writeRuntimeMetadata } from '../runtime-metadata'
import type { RpcMessageContext } from '../rpc/transport'
import type { RpcRequest, RpcResponse } from '../rpc/core'
import { errorResponse } from '../rpc/errors'
import { RuntimeRpcBinaryRouting } from './runtime-rpc-binary-routing'
import { classifyRuntimeLongPoll, type RuntimeLongPollClass } from './runtime-rpc-long-poll'
import { OWNER_RPC_CALLER_SCOPE, type RpcCallerScope } from '../rpc/rpc-caller-scope'

// Short calls that stop on disconnect without long-poll keepalives or admission slots.
const DISCONNECT_FORWARDED_METHODS = new Set([
  'browser.eval',
  'linear.commentEdit',
  'linear.commentDelete'
])

export class RuntimeRpcRequestAdmission extends RuntimeRpcBinaryRouting {
  // One-shot Unix requests use shared tokens from mode-0600 metadata (design §3.1).
  protected async handleMessage(
    rawMessage: string,
    context?: RpcMessageContext
  ): Promise<RpcResponse> {
    // Oversized clients arrive as empty messages before transport closes them.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    const parsed = this.parseAndAuth(rawMessage)
    if ('error' in parsed) {
      return parsed.error
    }
    const { request, callerScope } = parsed

    // Only long polls consume admission slots; short RPCs bypass (design §7).
    const longPoll = classifyRuntimeLongPoll(request)
    const rejection = this.admitLongPoll(longPoll)
    if (rejection) {
      return this.buildError(request.id, 'runtime_busy', rejection)
    }
    if (longPoll) {
      // Arm keepalives for long polls only; short calls pay no interval cost (design §3.1).
      context?.startKeepalive()
    }

    try {
      return await this.dispatcher.dispatch(request, {
        signal:
          longPoll || DISCONNECT_FORWARDED_METHODS.has(request.method)
            ? context?.signal
            : undefined,
        connectionSignal: context?.signal,
        callerScope
      })
    } finally {
      this.releaseLongPoll(longPoll)
    }
  }

  // Share total/ask fences across transports: preserve short-RPC slots and reserve wait/check capacity from slow asks.
  protected admitLongPoll(
    longPoll: RuntimeLongPollClass | null,
    pairedDeviceId?: string
  ): string | null {
    if (!longPoll) {
      return null
    }
    if (this.activeLongPolls >= this.longPollCap) {
      return 'long-poll capacity reached; retry with backoff'
    }
    if (
      (longPoll === 'ask' || longPoll === 'browser-host') &&
      this.activeAskLongPolls + this.activeBrowserHostLongPolls >= this.specializedLongPollCap
    ) {
      return longPoll === 'ask'
        ? 'orchestration.ask capacity reached; retry with backoff'
        : 'browser-host capacity reached; retry with backoff'
    }
    if (longPoll === 'ask' && this.activeAskLongPolls >= this.askLongPollCap) {
      return 'orchestration.ask capacity reached; retry with backoff'
    }
    if (
      longPoll === 'browser-host' &&
      (this.activeBrowserHostLongPolls >= this.browserHostLongPollCap ||
        (pairedDeviceId !== undefined &&
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) >=
            this.browserHostLongPollCapPerDevice))
    ) {
      return 'browser-host capacity reached; retry with backoff'
    }
    this.activeLongPolls += 1
    if (longPoll === 'ask') {
      this.activeAskLongPolls += 1
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls += 1
      if (pairedDeviceId !== undefined) {
        this.activeBrowserHostLongPollsByDevice.set(
          pairedDeviceId,
          (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 0) + 1
        )
      }
    }
    return null
  }

  protected releaseLongPoll(longPoll: RuntimeLongPollClass | null, pairedDeviceId?: string): void {
    if (!longPoll) {
      return
    }
    this.activeLongPolls = Math.max(0, this.activeLongPolls - 1)
    if (longPoll === 'ask') {
      this.activeAskLongPolls = Math.max(0, this.activeAskLongPolls - 1)
    } else if (longPoll === 'browser-host') {
      this.activeBrowserHostLongPolls = Math.max(0, this.activeBrowserHostLongPolls - 1)
      if (pairedDeviceId !== undefined) {
        const remaining = (this.activeBrowserHostLongPollsByDevice.get(pairedDeviceId) ?? 1) - 1
        if (remaining > 0) {
          this.activeBrowserHostLongPollsByDevice.set(pairedDeviceId, remaining)
        } else {
          this.activeBrowserHostLongPollsByDevice.delete(pairedDeviceId)
        }
      }
    }
  }

  protected parseAndAuth(
    rawMessage: string
  ): { request: RpcRequest; callerScope: RpcCallerScope } | { error: RpcResponse } {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return { error: this.buildError('unknown', 'bad_request', 'Invalid JSON request') }
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return { error: this.buildError('unknown', 'bad_request', 'Missing request id') }
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return { error: this.buildError(request.id, 'bad_request', 'Missing RPC method') }
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return { error: this.buildError(request.id, 'unauthorized', 'Missing auth token') }
    }
    if (request.authToken === this.authToken) {
      return { request, callerScope: OWNER_RPC_CALLER_SCOPE }
    }
    return { error: this.buildError(request.id, 'unauthorized', 'Invalid auth token') }
  }

  protected buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  protected writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}
