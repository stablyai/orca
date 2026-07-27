// Why: the dispatcher is the one place that knows how to turn a validated
// RPC request into a response envelope. Splitting it from the transport
// makes it unit-testable without spinning up a socket, and keeps
// runtime-rpc.ts focused on framing/auth/connection bookkeeping.
import {
  ZodError,
  InvalidArgumentError,
  buildRegistry,
  formatZodError,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type PairingRpcContext,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'

import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import {
  computerErrorData,
  errorResponse,
  mapBrowserError,
  mapEmulatorError,
  mapRuntimeError,
  successResponse
} from './errors'
import { ALL_RPC_METHODS } from './methods'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  OrchestrationMutationExecutor,
  authenticatedCallerFingerprint,
  type DurableMutationInvocation
} from './orchestration-mutation-executor'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { getRuntimeFeatureInteractionId } from './runtime-feature-interaction'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcAnyMethod[]
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    this.registry = buildRegistry(methods)
    this.orchestrationMutations = new OrchestrationMutationExecutor(runtime)
  }

  async dispatch(request: RpcRequest, options?: { signal?: AbortSignal }): Promise<RpcResponse> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      return errorResponse(
        request.id,
        meta,
        'method_not_found',
        `Unknown method: ${request.method}`
      )
    }

    const migrationFence = orchestrationMigrationFence(request, meta)
    if (migrationFence) {
      return migrationFence
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      return parsedParams.error
    }

    // Why: streaming methods are not supported over one-shot transports like
    // Unix sockets. They require a reply function that can be called multiple
    // times, which is only available via dispatchStreaming.
    if (isStreamingMethod(method)) {
      return errorResponse(
        request.id,
        meta,
        'method_not_supported',
        `Method ${request.method} requires a streaming transport`
      )
    }

    const isEmulator = request.method.startsWith('emulator.')
    if (isEmulator) {
      emulatorProbe(`rpc ${request.method}`, request.params)
    }
    try {
      const invoke = (mutation?: DurableMutationInvocation) =>
        method.handler(parsedParams.value, {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id,
          orchestrationCapability: request.orchestrationCapability,
          authenticatedCallerFingerprint: authenticatedCallerFingerprint(request),
          recordMutationReceipt: mutation?.recordReceipt,
          orchestrationMutation: mutation?.identity
        })
      const result = await this.orchestrationMutations.run(request, parsedParams.value, invoke)
      this.recordRuntimeFeatureInteraction(request.method, result, undefined, request.params)
      return successResponse(request.id, meta, result)
    } catch (error) {
      if (isEmulator) {
        emulatorProbeError(`rpc ${request.method}`, error, { params: request.params })
      }
      return this.mapError(request, meta, error)
    }
  }

  // Why: streaming dispatch sends multiple responses through the reply callback
  // instead of returning a single Promise. This enables terminal.subscribe and
  // other subscription-style methods that push data over time.
  async dispatchStreaming(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: {
      connectionId?: string
      signal?: AbortSignal
      clientId?: string
      pairedDeviceId?: string
      clientKind?: 'mobile' | 'runtime'
      pairing?: PairingRpcContext
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      registerBinaryStreamHandler?: (
        streamId: number,
        handler: (frame: TerminalStreamFrame) => void
      ) => () => void
    }
  ): Promise<void> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      reply(
        JSON.stringify(
          errorResponse(request.id, meta, 'method_not_found', `Unknown method: ${request.method}`)
        )
      )
      return
    }

    const migrationFence = orchestrationMigrationFence(request, meta)
    if (migrationFence) {
      reply(JSON.stringify(migrationFence))
      return
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      try {
        const invoke = (mutation?: DurableMutationInvocation) =>
          method.handler(parsedParams.value, {
            runtime: this.runtime,
            signal: options?.signal,
            requestId: request.id,
            connectionId: options?.connectionId,
            clientId: options?.clientId,
            pairedDeviceId: options?.pairedDeviceId,
            clientKind: options?.clientKind,
            orchestrationCapability: request.orchestrationCapability,
            authenticatedCallerFingerprint: authenticatedCallerFingerprint(request),
            recordMutationReceipt: mutation?.recordReceipt,
            orchestrationMutation: mutation?.identity,
            pairing: options?.pairing,
            sendBinary: options?.sendBinary,
            registerBinaryStreamHandler: options?.registerBinaryStreamHandler
          })
        const result = await this.orchestrationMutations.run(request, parsedParams.value, invoke)
        this.recordRuntimeFeatureInteraction(request.method, result, undefined, request.params)
        reply(JSON.stringify(successResponse(request.id, meta, result)))
      } catch (error) {
        reply(JSON.stringify(this.mapError(request, meta, error)))
      }
      return
    }

    const recordedStreamingFeatureInteractions = new Set<FeatureInteractionId>()
    const emit = (result: unknown): void => {
      this.recordRuntimeFeatureInteraction(
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
      const response = successResponse(request.id, meta, result)
      response.streaming = true
      reply(JSON.stringify(response))
    }

    try {
      const result = await method.handler(
        parsedParams.value,
        {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          pairedDeviceId: options?.pairedDeviceId,
          clientKind: options?.clientKind,
          pairing: options?.pairing,
          sendBinary: options?.sendBinary,
          registerBinaryStreamHandler: options?.registerBinaryStreamHandler
        },
        emit
      )
      this.recordRuntimeFeatureInteraction(
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(this.mapError(request, meta, error)))
    }
  }

  private parseParams(
    request: RpcRequest,
    method: RpcAnyMethod,
    meta: RpcEnvelopeMeta
  ): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
    if (method.params === null) {
      return { value: undefined }
    }
    const rawParams = request.params ?? {}
    const result = method.params.safeParse(rawParams)
    if (!result.success) {
      return {
        error: this.invalidArgumentResponse(request, meta, formatZodError(result.error))
      }
    }
    return { value: result.data }
  }

  private mapError(request: RpcRequest, meta: RpcEnvelopeMeta, error: unknown): RpcResponse {
    if (error instanceof ZodError) {
      return this.invalidArgumentResponse(request, meta, formatZodError(error))
    }
    if (error instanceof InvalidArgumentError) {
      return this.invalidArgumentResponse(request, meta, error.message)
    }

    // Why: browser methods throw BrowserError with a structured `code`;
    // every other runtime error has a plain-message code. Routing by method
    // prefix keeps the mapping a single decision rather than a per-method
    // flag callers must remember to set.
    if (request.method.startsWith('browser.')) {
      return mapBrowserError(request.id, meta, error)
    }
    if (request.method.startsWith('emulator.')) {
      return mapEmulatorError(request.id, meta, error)
    }
    return mapRuntimeError(request.id, meta, error)
  }

  private invalidArgumentResponse(
    request: RpcRequest,
    meta: RpcEnvelopeMeta,
    message: string
  ): RpcResponse {
    return errorResponse(
      request.id,
      meta,
      'invalid_argument',
      message,
      request.method.startsWith('computer.') ? computerErrorData('invalid_argument') : undefined
    )
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }

  private recordRuntimeFeatureInteraction(
    method: string,
    result: unknown,
    alreadyRecorded?: Set<FeatureInteractionId>,
    rawParams?: unknown
  ): void {
    const id = getRuntimeFeatureInteractionId(method, result, rawParams)
    if (!id) {
      return
    }
    if (alreadyRecorded?.has(id)) {
      return
    }
    try {
      this.runtime.recordFeatureInteraction(id)
      alreadyRecorded?.add(id)
    } catch {
      // Best-effort education state must not break runtime tools.
    }
  }
}
