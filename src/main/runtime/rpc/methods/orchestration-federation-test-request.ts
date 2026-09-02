import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RpcRequest } from '../core'

export function createFederationWorkerStartRequest(
  taskId: string,
  overrides: Record<string, unknown> = {}
): RpcRequest {
  return {
    id: 'rpc_worker_start',
    authToken: 'coordinator-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: 'request_windows_worker',
    method: 'orchestration.workerStart',
    params: {
      task: taskId,
      from: 'term_coord',
      on: 'windows',
      worktree: 'new-top-level',
      repo: 'id:windows-repo',
      name: 'windows-audit',
      agent: 'codex',
      ...overrides
    }
  }
}
