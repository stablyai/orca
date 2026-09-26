// The ways an offer ends. Every ending is the user's own act, and every ending DELETES the
// durable record — nothing stays behind to be re-filtered on every later read.

import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

// The user answering the chat themselves is the one signal the offer is moot. The next listing
// notices and deletes the durable record, not merely hides it.
it('deletes the offer once the user sends their own message in that chat', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toHaveLength(1)

  await host.hold(SESSION, 'pane')
  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const body = hostTestMessage('Never mind, do this instead')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  expect(await host.restartResume.list()).toEqual([])
  await vi.waitFor(async () => {
    expect(await capsule.list(NOW)).toEqual([])
  })
  host.release(SESSION, 'pane')
})

// A journal this host cannot read says nothing about the user moving on, so it must not end the offer.
it('keeps the offer when the chat cannot be read on this host', async () => {
  const { host, root } = await interruptedRestart('submission')
  const capsule = new AgentSessionRecoveryCapsule(root)
  const restoring = vi
    .spyOn(StructuredAgentSessionReadableRestorer.prototype, 'restoreOne')
    .mockRejectedValue(new Error('journal unreadable'))
  try {
    expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
  } finally {
    restoring.mockRestore()
  }
  expect(await capsule.list(NOW)).toHaveLength(1)
  expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
})

// Closing the chat is discarding it; its offer must not outlive it in the restart dialog.
it('deletes the offer when the chat itself is closed', async () => {
  const { host, root } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toHaveLength(1)

  await host.setSessionTabVisibility(SESSION, false)

  await vi.waitFor(async () => {
    expect(await capsule.list(NOW)).toEqual([])
  })
})

// A failure record is the same obligation in a later state; the chat's close ends it too.
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
