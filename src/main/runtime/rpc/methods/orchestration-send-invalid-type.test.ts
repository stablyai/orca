import { afterEach, describe, expect, it } from 'vitest'
import type { RpcRequest } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

describe('orchestration.send invalid message type', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
  })

  it('explains valid message types and the question reply path', async () => {
    const { runtime, ctx } = h.setup()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const request: RpcRequest = {
      id: 'req_1',
      authToken: 'token',
      method: 'orchestration.send',
      params: { to: 'b', subject: 'hi', type: 'answer' },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    }

    const response = await dispatcher.dispatch(request, ctx)

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message:
          'Invalid --type. Expected one of: status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat. To answer a worker question, use the same Orca CLI executable with orchestration reply --id <msg_id> --body <text>.'
      }
    })
  })
})
