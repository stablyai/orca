import { afterEach, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { waitFor } from './acp-structured-adapter.test-support'
import { attachParams, openHostRig, send } from './acp-structured-host.test-support'

afterEach(closeProviderTimelineRigs)

it('tells queued messages the agent is signed out when its published startup fails authentication', async () => {
  const { rig, host } = await openHostRig({
    script: (agent) => agent.on('session/new', () => {})
  })
  expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
  const request = await rig.frame('session/new')
  const messageId = await send(host, 'held during sign-in')
  expect(rig.sent('session/prompt')).toEqual([])
  rig.child().agent.fail(request, -32000, 'Authentication required')
  await waitFor(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    const submission = snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
    expect(submission?.handedOverAt).toBeUndefined()
    expect(submission).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'notSignedIn' },
      reason: expect.stringMatching(/^Sign in to Grok/)
    })
  })
  expect(rig.child().exited).toBe(true)
  expect(rig.sent('session/prompt')).toEqual([])
})
