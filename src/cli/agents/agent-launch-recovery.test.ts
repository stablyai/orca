import { expect, it } from 'vitest'
import { RuntimeRpcFailureError } from '../runtime/connection/types'
import { withCliAgentLaunchRecovery } from './agent-launch-recovery'

it('keeps the host field refusal visible when a replay cannot confirm the launch outcome', async () => {
  const refused = new RuntimeRpcFailureError({
    id: 'launch-replay',
    ok: false,
    error: { code: 'invalid_argument', message: 'Malformed launch pane key' }
  })
  await expect(
    withCliAgentLaunchRecovery(Promise.reject(refused), {
      operationId: '1767225600000-00000000000040008000000000000002',
      replayed: true,
      params: {}
    })
  ).rejects.toMatchObject({
    code: 'agent_session_operation_unknown',
    message: expect.stringContaining('Malformed launch pane key')
  })
})
