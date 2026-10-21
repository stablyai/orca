// An offer across a failed attempt and its retry, and across builds: the message Resume sends
// depends on the marker alone, and each action sends its own.

import { expect, it } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../shared/agent-session-restart-continuation'
import { restartContinuationBody } from './structured-agent-session-restart-continuation-envelope'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// The first attempt's start failed, so its continuation was rejected and never reached the agent.
// A retry is a new action with a new message, not a replay of the rejected one, and it is
// delivered with the same body.
it("delivers a retry as a new continuation after the first one's start failed", async () => {
  const { host, acquire, dispatch, marker } = await interruptedRestart('children')
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  const first = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(first.failed).toMatchObject([{ sessionId: SESSION, outcome: 'refused', retryable: true }])
  const [rejected] = (await host.journalSnapshot(SESSION)).submissions
  expect(rejected).toMatchObject({ dispatchState: 'rejected' })

  const retried = await host.restartResume.continueAfterRestart([SESSION], 'retry')

  expect(retried.continued).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch).toHaveBeenCalledOnce()
  const sent = dispatch.mock.calls[0]?.[0]
  expect(sent?.clientMessageId).not.toBe(rejected?.clientMessageId)
  expect(sent?.body).toEqual(restartContinuationBody(marker))
  expect((await host.journalSnapshot(SESSION)).submissions).toMatchObject([
    { clientMessageId: rejected?.clientMessageId, dispatchState: 'rejected' },
    { clientMessageId: sent?.clientMessageId, dispatchState: 'accepted' }
  ])
  expect(retried.failed).toEqual([])
})

// A marker from a build that recorded only a working lead: no snapshot, so no activity to name,
// and the original wording.
it('offers and continues a marker with no snapshot', async () => {
  const { host, root, dispatch, marker } = await interruptedRestart('children')
  if (!marker) {
    throw new Error('missing interrupted restart marker')
  }
  const { activity: _activity, ...older } = marker
  await host.restartResume.dismiss([SESSION])
  await new AgentSessionRecoveryCapsule(root).record([older], NOW)

  const [offer] = await host.restartResume.list()
  expect(offer).toMatchObject({ sessionId: SESSION })
  expect(offer).not.toHaveProperty('activity')
  expect(
    (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
  ).toMatchObject([{ outcome: 'continued' }])
  expect(dispatch.mock.calls[0]?.[0].body.blocks).toEqual([
    { type: 'text', text: AGENT_SESSION_RESTART_CONTINUATION_MESSAGE }
  ])
})
