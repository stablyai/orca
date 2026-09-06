import { isStreamingMethod, type RpcEnvelopeMeta, type RpcRegistry, type RpcRequest } from './core'

import { errorResponse, successResponse } from './errors'
import type { OrcaRuntimeService } from '../orca-runtime'
import type {
  OrchestrationMutationExecutor,
  DurableMutationInvocation
} from './orchestration-mutation-executor'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import type { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import { routeDispatcherClientHostedBrowserRpc } from './dispatcher-client-browser-routing'
import { needsLocalCallerFingerprint } from './dispatcher-caller-fingerprint'
import { createDispatcherStreamingFeatureEmitter } from './dispatcher-streaming-feature-emitter'

export type RpcStreamingDispatcherDependencies = {
  runtime: OrcaRuntimeService
  registry: RpcRegistry
  orchestrationMutations: OrchestrationMutationExecutor
  legacyOrchestration: OrchestrationLegacyCompatibility
  meta: () => RpcEnvelopeMeta
}

export class RpcStreamingDispatcher {
  constructor(private readonly dependencies: RpcStreamingDispatcherDependencies) {}

  // Why: streaming dispatch sends multiple responses through the reply callback instead of a Promise.
  async dispatch(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    const { runtime, registry, orchestrationMutations, legacyOrchestration, meta } =
      this.dependencies
    const envelopeMeta = meta()
    const method = registry.get(request.method)
    if (!method) {
      reply(
        JSON.stringify(
          errorResponse(
            request.id,
            envelopeMeta,
            'method_not_found',
            `Unknown method: ${request.method}`
          )
        )
      )
      return
    }

    const migrationFence = orchestrationMigrationFence(request, envelopeMeta)
    if (migrationFence) {
      reply(JSON.stringify(migrationFence))
      return
    }

    const parsedParams = parseRpcRequestParams(request, method, envelopeMeta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      try {
        const clientHostedBrowser = await routeDispatcherClientHostedBrowserRpc(
          runtime,
          request.method,
          parsedParams.value
        )
        if (clientHostedBrowser.handled) {
          recordRuntimeFeatureInteraction(
            runtime,
            request.method,
            clientHostedBrowser.result,
            undefined,
            request.params
          )
          reply(
            JSON.stringify(successResponse(request.id, envelopeMeta, clientHostedBrowser.result))
          )
          return
        }
        const compatibility = await legacyOrchestration.tryHandle(
          request,
          parsedParams.value,
          options?.signal
        )
        if (compatibility.handled) {
          reply(JSON.stringify(successResponse(request.id, envelopeMeta, compatibility.result)))
          return
        }
        const effectiveParams = compatibility.params ?? parsedParams.value
        const legacyCoordinator = legacyOrchestration.createCoordinatorInvocation(
          request,
          compatibility.legacyCoordinatorAuthority
        )
        const authenticatedCallerFingerprint =
          options?.authenticatedCallerFingerprint ??
          (needsLocalCallerFingerprint(request, effectiveParams)
            ? orchestrationMutations.getLocalAuthenticatedCallerFingerprint()
            : undefined)
        const invoke = (mutation?: DurableMutationInvocation) => {
          const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
          return method.handler(effectiveParams, {
            runtime,
            signal: options?.signal,
            requestId: request.id,
            connectionId: options?.connectionId,
            clientId: options?.clientId,
            pairedDeviceId: options?.pairedDeviceId,
            clientKind: options?.clientKind,
            clientCapabilities: options?.clientCapabilities,
            updateClientCapabilities: options?.updateClientCapabilities,
            orchestrationCapability: request.orchestrationCapability,
            authenticatedCallerFingerprint:
              mutation?.identity.callerFingerprint ??
              legacyCoordinator?.mutationCallerFingerprint ??
              authenticatedCallerFingerprint,
            recordMutationReceipt: mutation?.recordReceipt,
            orchestrationMutation: mutation?.identity,
            pairing: options?.pairing,
            sendBinary: options?.sendBinary,
            registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
            registerBinaryMessageHandler: options?.registerBinaryMessageHandler,
            legacyCoordinatorRunId,
            legacyCoordinatorAuthority: legacyCoordinator?.authority,
            revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
            orchestrationCompatibilityCallerAuthority:
              compatibility.orchestrationCompatibilityCallerAuthority,
            orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
          })
        }
        const result = await orchestrationMutations.run(
          request,
          effectiveParams,
          invoke,
          legacyCoordinator?.mutationCallerFingerprint ?? authenticatedCallerFingerprint
        )
        recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
        reply(JSON.stringify(successResponse(request.id, envelopeMeta, result)))
      } catch (error) {
        reply(JSON.stringify(mapDispatcherError(request, envelopeMeta, error)))
      }
      return
    }

    const { emit, recordedFeatureInteractions } = createDispatcherStreamingFeatureEmitter(
      runtime,
      request,
      envelopeMeta,
      reply
    )

    try {
      const result = await method.handler(
        parsedParams.value,
        {
          runtime,
          signal: options?.signal,
          requestId: request.id,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          pairedDeviceId: options?.pairedDeviceId,
          clientKind: options?.clientKind,
          clientCapabilities: options?.clientCapabilities,
          updateClientCapabilities: options?.updateClientCapabilities,
          orchestrationCapability: request.orchestrationCapability,
          pairing: options?.pairing,
          sendBinary: options?.sendBinary,
          registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
          registerBinaryMessageHandler: options?.registerBinaryMessageHandler
        },
        emit
      )
      recordRuntimeFeatureInteraction(
        runtime,
        request.method,
        result,
        recordedFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(mapDispatcherError(request, envelopeMeta, error)))
    }
  }
}
