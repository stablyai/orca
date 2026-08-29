import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'
import type { RpcRequest } from './core'

export function needsLocalCallerFingerprint(request: RpcRequest, params: unknown): boolean {
  return (
    request.method.startsWith('orchestration.federation') ||
    (!!request.orchestrationRequestId && isOrchestrationMutation(request.method, params))
  )
}
