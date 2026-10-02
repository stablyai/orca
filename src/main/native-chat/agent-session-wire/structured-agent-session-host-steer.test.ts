import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER,
  restTestSend
} from './structured-agent-session-rest-test-rig'

it('hands steer to the same provider dispatcher once and never retries an unknown delivery', async () => {
  const rig = await createRestTestRig()
  try {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'lost receipt' })
    const params = restTestSend('change course')
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.steer',
      sessionId: params.envelope.sessionId,
      fields: { body: params.body }
    })
    const result = await rig.host.steer(REST_TEST_CALLER, params)
    expect(result).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    await rig.host.steer(REST_TEST_CALLER, params)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
    expect(rig.adapter.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: params.body })
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  } finally {
    await rig.dispose()
  }
})
