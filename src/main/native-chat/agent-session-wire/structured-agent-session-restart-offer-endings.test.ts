// The ways an offer ends. Every ending DELETES the durable record — nothing stays behind to be
// re-filtered on every later read.

import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { rename, writeFile, rm } from 'node:fs/promises'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

// The user's own message starts the chat's agent again, which ends the offer: the durable record
// is deleted, not merely hidden (R-04).
it('deletes the offer once the user sends their own message in that chat', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.list(NOW)).toHaveLength(1)

  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const body = hostTestMessage('Never mind, do this instead')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  // Written when the agent's start is proven: a cold start.
  await vi.waitFor(
    async () => {
      expect(await capsule.list(NOW)).toEqual([])
    },
    { timeout: 10_000 }
  )
  expect(await host.restartResume.list()).toEqual([])
})

// A journal this host cannot read decides nothing, so it must not end the offer.
it('keeps the offer when the chat cannot be read on this host', async () => {
  const { host, root, store } = await interruptedRestart('submission')
  const capsule = new AgentSessionRecoveryCapsule(root)
  const location = store.getRecord(SESSION)?.location
  if (!location) {
    throw new Error('missing session record')
  }
  // A file where the journal directory belongs: this host cannot open the conversation at all.
  const journalDir = journalDirectoryFor(root, {
    workspaceId: location.workspaceId,
    sessionId: SESSION
  })
  await rename(journalDir, `${journalDir}.aside`)
  await writeFile(journalDir, 'not a journal')
  try {
    expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION }])
  } finally {
    await rm(journalDir)
    await rename(`${journalDir}.aside`, journalDir)
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
