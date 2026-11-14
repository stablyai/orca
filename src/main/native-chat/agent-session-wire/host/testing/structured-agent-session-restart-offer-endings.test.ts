import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'

import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW as NOW, hostTestMessage } from './structured-agent-session-host-test-data'

it('deletes the offer once the user sends their own message in that chat', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toHaveLength(1)

  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const body = hostTestMessage('Never mind, do this instead')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  await vi.waitFor(
    async () => {
      expect(await capsule.list(NOW)).toEqual([])
    },
    { timeout: 10_000 }
  )
  expect(await host.restartResume.list()).toEqual([])
})
