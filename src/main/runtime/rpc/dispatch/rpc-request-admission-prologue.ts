import type {
  RpcEnvelopeMeta,
  RpcMethod,
  RpcRegistry,
  RpcRequest,
  RpcResponse,
  RpcStreamingMethod
} from '../core'
import { errorResponse } from '../responses/rpc-response'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { orchestrationMigrationFence } from '../orchestration/compatibility/orchestration-contract-fence'
import { runtimeSourceFence } from './runtime-source-admission'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from '../responses/dispatcher-error-response'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import {
  denyRpcMethodForCaller,
  OWNER_RPC_CALLER_SCOPE,
  type RpcCallerScope
} from '../callers/rpc-caller-scope'
import {
  needsOrchestrationCallerResolution,
  resolveOrchestrationSessionCaller,
  type ResolvedOrchestrationRequest
} from '../orchestration/callers/orchestration-session-caller'
import { admitOrchestrationPeerCall } from '../orchestration/callers/orchestration-peer-caller'
import { waitForRestoredWorkerCallerIdentity } from '../orchestration/callers/worker-caller-identity-restore-wait'

type RpcRequestAdmissionDeps = {
  runtime: OrcaRuntimeService
  registry: RpcRegistry
  meta: RpcEnvelopeMeta
  pinnedCallerScope?: RpcCallerScope
}

// Both transports must admit/refuse and resolve callers in identical order before handlers.
export function admitRpcRequest<M extends RpcMethod | RpcStreamingMethod>(
  { runtime, registry, meta, pinnedCallerScope }: RpcRequestAdmissionDeps,
  rawRequest: RpcRequest,
  options: RpcDispatchStreamingOptions | undefined,
  isTransportSupported: (method: RpcMethod | RpcStreamingMethod) => method is M
) {
  const reject = (rejected: RpcResponse) => ({ rejected })
  const method = registry.get(rawRequest.method)
  const callerScope = pinnedCallerScope ?? options?.callerScope ?? OWNER_RPC_CALLER_SCOPE
  const denial = denyRpcMethodForCaller(callerScope, rawRequest.method, method?.permission)
  if (denial) {
    return reject(errorResponse(rawRequest.id, meta, 'forbidden', denial))
  }
  if (!method) {
    return reject(
      errorResponse(rawRequest.id, meta, 'method_not_found', `Unknown method: ${rawRequest.method}`)
    )
  }
  const sourceFence = runtimeSourceFence(rawRequest, meta)
  if (sourceFence) {
    return reject(sourceFence)
  }
  const migrationFence = orchestrationMigrationFence(rawRequest, meta)
  if (migrationFence) {
    return reject(migrationFence)
  }

  let peer: ReturnType<typeof admitOrchestrationPeerCall>
  try {
    peer = admitOrchestrationPeerCall(runtime, rawRequest, method, options)
  } catch (error) {
    return reject(mapDispatcherError(rawRequest, meta, error))
  }

  const admitResolved = ({ request, caller }: ResolvedOrchestrationRequest) => {
    const parsedParams = parseRpcRequestParams(request, method, meta)
    if (parsedParams.error) {
      return reject(parsedParams.error)
    }
    if (!isTransportSupported(method)) {
      return reject(
        errorResponse(
          request.id,
          meta,
          'method_not_supported',
          `Method ${request.method} requires a streaming transport`
        )
      )
    }
    return { method, request, caller, params: parsedParams.value }
  }
  if (peer) {
    return admitResolved(peer)
  }
  // Resolve once before parse and unary/streaming branching so both see the same caller.
  const callerField = method.orchestrationAccess?.caller
  if (needsOrchestrationCallerResolution(rawRequest, callerField)) {
    return resolveOrchestrationSessionCaller(runtime, rawRequest, options, callerField).then(
      admitResolved,
      (error) => reject(mapDispatcherError(rawRequest, meta, error))
    )
  }
  const identityRestore = waitForRestoredWorkerCallerIdentity(runtime, rawRequest, callerField, [
    options?.signal,
    options?.connectionSignal
  ])
  return identityRestore
    ? identityRestore.then(
        () => admitResolved({ request: rawRequest }),
        (error) => reject(mapDispatcherError(rawRequest, meta, error))
      )
    : admitResolved({ request: rawRequest })
}
