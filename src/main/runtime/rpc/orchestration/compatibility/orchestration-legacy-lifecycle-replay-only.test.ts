import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest } from '../../core'
import type { LegacyCompatibilityAuthority } from './orchestration-legacy-authority'
import { handleLegacyLifecycleSend } from './orchestration-legacy-lifecycle'

const params = {
  from: 'term_worker',
  subject: 'Done',
  type: 'worker_done',
  payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_legacy', outcome: 'succeeded' })
}

function send(contractVersion: number) {
  const request: RpcRequest = {
    id: 'rpc_1',
    authToken: 'token',
    method: 'orchestration.send',
    params,
    orchestrationContractVersion: contractVersion,
    orchestrationRequestId: 'mutation_1'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal comes before any runtime use.
  const runtime = {} as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the Dispatch lookup is read before the refusal.
  const authority = {
    resolveWorkerDispatch: () => ({ id: 'ctx_legacy', run_id: 'run_legacy' })
  } as unknown as LegacyCompatibilityAuthority
  return handleLegacyLifecycleSend({ runtime, authority, request, params })
}

describe('legacy lifecycle mail for a replay-only worker_done', () => {
  it('is refused before any effect, since legacy mail keeps no receipt to replay', async () => {
    await expect(send(ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION)).rejects.toMatchObject({
      code: 'retry_not_replayable',
      data: { requestId: 'mutation_1', reason: 'route_keeps_no_receipt', effectsApplied: false }
    })
  })

  it('goes on to the ordinary legacy checks under the ordinary contract', async () => {
    // Without --to, the ordinary path stops at its own argument check.
    await expect(send(ORCHESTRATION_CONTRACT_VERSION)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})
