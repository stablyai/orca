import { openAcpAdapterRig } from '../testing/acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpAgentError } from '../../transport/acp-errors'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

it('propagates a temporary load envelope before takeover or a dead-child assertion can replace it', async () => {
  const rig = await openAcpAdapterRig({
    launch: {
      resume: {
        key: 'saved-key',
        sessionId: 'saved-id',
        mayBeUnsaved: async () => false,
        lossKeys: []
      }
    },
    script: (agent) =>
      agent.on('session/load', (frame) =>
        agent.fail(frame, -32603, 'server unavailable', { errorName: 'ServerUnavailable' })
      )
  })
  await rig.acquire()
  // The adapter answers for its own declared-temporary answer, which it keeps as the cause.
  expect(rig.openVerdict()).toMatchObject({ retry: 'safe' })
  expect(rig.openFailure()).toBeInstanceOf(AcpAgentError)
  expect(rig.openFailure()).toMatchObject({ data: { errorName: 'ServerUnavailable' } })
  expect(rig.sent('session/new')).toEqual([])
  expect(rig.sent('session/load')[0].params).toMatchObject({ sessionId: 'saved-id' })
  await rig.adapter.closeAll()
})
