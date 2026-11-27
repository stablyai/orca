import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationEntryCaller } from '../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext, RpcRequest } from './core'
import type { RpcCallerScope } from './callers/rpc-caller-scope'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatch/dispatcher-stream-options'
import { assertLookAroundMayCall } from './look-around-rpc-guard'

/** A call's context. Handlers see the scope admission checked, which a pinned dispatcher sets for every call. */
export function rpcCallContext(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  options: RpcDispatchStreamingOptions | undefined,
  pinned: RpcCallerScope | undefined,
  caller: OrchestrationEntryCaller | undefined,
  params: unknown
): RpcContext {
  const scoped = pinned ? { ...options, callerScope: pinned } : options
  return rpcContextFromTransport(runtime, request, scoped, caller, params)
}

/** A unary call's context, refused before any routing when a bot's look-around or tidy-up run may not make it. */
export function guardedRpcCallContext(...args: Parameters<typeof rpcCallContext>): RpcContext {
  const context = rpcCallContext(...args)
  const [runtime, request, , , , params] = args
  assertLookAroundMayCall(runtime, request, context.pairedDeviceId, params)
  return context
}
