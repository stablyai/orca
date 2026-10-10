import type {
  RpcEnvelopeMeta,
  RpcMethod,
  RpcRegistry,
  RpcRequest,
  RpcResponse,
  RpcStreamingMethod
} from './core'
import { errorResponse } from './errors'
import type { OrcaRuntimeService } from '../orca-runtime'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import type { SshBridgeCallBinding } from './ssh-bridge-host-binding'
import {
  bindRpcCallToCallerScope,
  denyRpcMethodForCaller,
  OWNER_RPC_CALLER_SCOPE,
  type RpcCallerScope
} from './rpc-caller-scope'
import {
  needsOrchestrationCallerResolution,
  resolveOrchestrationSessionCaller,
  type ResolvedOrchestrationRequest
} from './orchestration-session-caller'

type RpcRequestAdmissionDeps = {
  runtime: OrcaRuntimeService
  registry: RpcRegistry
  meta: RpcEnvelopeMeta
  pinnedCallerScope?: RpcCallerScope
}

// Why: both transports must reject, resolve and bind a request in the same order before any handler runs.
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
  const migrationFence = orchestrationMigrationFence(rawRequest, meta)
  if (migrationFence) {
    return reject(migrationFence)
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
    const params = parsedParams.value
    const admit = (binding: SshBridgeCallBinding | null) =>
      binding?.kind === 'denied'
        ? reject(errorResponse(request.id, meta, 'forbidden', binding.message))
        : { method, request, caller, params, binding }
    // Why: an unbound call stays synchronous, so dispatch gains no extra tick before the handler.
    const pendingBinding = bindRpcCallToCallerScope(callerScope, runtime, request.method, params)
    return pendingBinding ? pendingBinding.then(admit) : admit(null)
  }
  // Why: before params parse and the unary/streaming split, so both branches see one caller.
  return needsOrchestrationCallerResolution(rawRequest)
    ? resolveOrchestrationSessionCaller(runtime, rawRequest, options).then(admitResolved, (error) =>
        reject(mapDispatcherError(rawRequest, meta, error))
      )
    : admitResolved({ request: rawRequest })
}
