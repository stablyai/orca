import { parseExecutionHostId } from '../../../shared/execution-host'
import type { RpcRequest } from '../rpc/core'
import { denyRpcMethodForCaller, type RpcCallerScope } from '../rpc/rpc-caller-scope'
import type { RpcMethodPermission } from '../rpc/rpc-method-permission'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

const RUNTIME_TARGET_PREFIX = 'runtime:'

export type RuntimeClientRelayAdmission =
  | { kind: 'run-here' }
  | { kind: 'relay' }
  | { kind: 'refused'; code: 'invalid_argument' | 'forbidden'; message: string }

/** A paired desktop/web client that names a server never has the call silently run here instead:
 * execution-host routes relay, desktop-owned routes stay here as for phones, anything else is refused. */
export function runtimeClientRelayAdmission(
  request: Pick<RpcRequest, 'method' | 'executionHost'>,
  callerScope: RpcCallerScope,
  permission: RpcMethodPermission | undefined
): RuntimeClientRelayAdmission {
  const { executionHost } = request
  if (
    typeof executionHost !== 'string' ||
    !executionHost.trim().startsWith(RUNTIME_TARGET_PREFIX)
  ) {
    return { kind: 'run-here' }
  }
  if (parseExecutionHostId(executionHost)?.kind !== 'runtime') {
    return { kind: 'refused', code: 'invalid_argument', message: 'Invalid executionHost' }
  }
  const route = MOBILE_RPC_METHOD_ROUTES.get(request.method)
  if (route === 'paired-desktop') {
    return { kind: 'run-here' }
  }
  if (route !== 'execution-host') {
    return {
      kind: 'refused',
      code: 'forbidden',
      message: `Method '${request.method}' cannot run on a server this computer relays to`
    }
  }
  // The server sees a phone child, so the client's own grants must admit the call before it leaves.
  const denial = denyRpcMethodForCaller(callerScope, request.method, permission)
  return denial ? { kind: 'refused', code: 'forbidden', message: denial } : { kind: 'relay' }
}
