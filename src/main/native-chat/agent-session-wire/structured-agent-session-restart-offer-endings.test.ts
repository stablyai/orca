import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

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

it('keeps the offer when the chat cannot be read on this host', async () => {
  const { host, root } = await interruptedRestart('submission')
  const capsule = new AgentSessionRecoveryCapsule(root)
  const open = vi
    .spyOn(AgentSessionJournal.prototype, 'open')
    .mockRejectedValue(Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' }))
  try {
    expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
  } finally {
    open.mockRestore()
  }
  expect(await capsule.list(NOW)).toHaveLength(1)
  expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
})

it('deletes the offer when the chat itself is closed', async () => {
  const { host, root } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toHaveLength(1)

  await host.setSessionTabVisibility(SESSION, false)

  await vi.waitFor(async () => {
    expect(await capsule.list(NOW)).toEqual([])
  })
})

it('deletes a failed-resume record when the chat itself is closed', async () => {
  const { host, root, acquire } = await interruptedRestart()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toHaveLength(1)

  await host.setSessionTabVisibility(SESSION, false)

  await vi.waitFor(async () => {
    expect(await capsule.listFailed(NOW)).toEqual([])
  })
})
