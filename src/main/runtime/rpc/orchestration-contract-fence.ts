import {
  isOrchestrationMutation,
  isRetiredOrchestrationMethod,
  orchestrationMigrationData,
  type OrchestrationMigrationReason
} from '../../../shared/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from './core'
import { errorResponse } from './errors'

export function orchestrationMigrationFence(
  request: RpcRequest,
  meta: RpcEnvelopeMeta
): RpcResponse | undefined {
  if (!isOrchestrationMutation(request.method, request.params)) {
    return undefined
  }
  let reason: OrchestrationMigrationReason | undefined
  if (isRetiredOrchestrationMethod(request.method)) {
    reason = 'command_retired'
  } else if (request.orchestrationContractVersion === undefined) {
    reason = 'client_contract_missing'
  } else if (request.orchestrationContractVersion !== ORCHESTRATION_CONTRACT_VERSION) {
    reason = 'client_contract_unsupported'
  }
  if (!reason) {
    return undefined
  }
  return errorResponse(
    request.id,
    meta,
    'orchestration_migration_required',
    'This orchestration mutation uses an obsolete contract. No effects were applied.',
    orchestrationMigrationData(reason)
  )
}
