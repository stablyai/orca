import {
  isOrchestrationMutation,
  isRetiredOrchestrationMethod,
  orchestrationMigrationData,
  type OrchestrationMigrationReason
} from '../../../../../shared/orchestration/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { isReplayOnlyRequest } from '../../../orchestration/db/mutation-receipts/replay-only-request'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from '../../core'
import { errorResponse } from '../../responses/rpc-response'

export function orchestrationMigrationFence(
  request: RpcRequest,
  meta: RpcEnvelopeMeta
): RpcResponse | undefined {
  let reason: OrchestrationMigrationReason | undefined
  // Before the read, legacy and peer routes: replay-only is admitted for its one producer, nothing
  // else. That producer never names a peer Run, and admitting one would commit its conversation,
  // Run or label before the receipt lookup could refuse the replay.
  if (isReplayOnlyRequest(request)) {
    reason =
      isKeyedWorkerDone(request) && request.orchestrationPeerRun === undefined
        ? undefined
        : 'client_contract_unsupported'
  } else if (!isOrchestrationMutation(request.method, request.params)) {
    return undefined
  } else if (isRetiredOrchestrationMethod(request.method)) {
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

/** The only replay-only request a client sends: a worker_done send under its original request id. */
function isKeyedWorkerDone(request: RpcRequest): boolean {
  const params: unknown = request.params
  return (
    request.method === 'orchestration.send' &&
    typeof request.orchestrationRequestId === 'string' &&
    request.orchestrationRequestId.length > 0 &&
    typeof params === 'object' &&
    params !== null &&
    'type' in params &&
    params.type === 'worker_done'
  )
}
