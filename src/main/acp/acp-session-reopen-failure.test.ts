import { openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpAgentError } from './acp-errors'
import { acpReopenTakeover } from './acp-session-reopen-failure'

it.each(['ServerUnavailable', 'CatalogNotReady'])(
  'retains the saved session on a temporary %s load answer',
  (errorName) => {
    const error = new AcpAgentError(-32603, 'not ready', { errorName })
    const warn = vi.fn()
    expect(() =>
      acpReopenTakeover(
        error,
        { key: 'saved-key', sessionId: 'saved-id', mayBeUnsaved: () => false },
        { over: false, now: 1, warn }
      )
    ).toThrow(error)
    expect(warn).not.toHaveBeenCalled()
  }
)

afterEach(closeProviderTimelineRigs)

it('propagates a temporary load envelope before takeover or a dead-child assertion can replace it', async () => {
  const rig = await openAcpAdapterRig({
    launch: { resume: { key: 'saved-key', sessionId: 'saved-id', mayBeUnsaved: () => false } },
    script: (agent) =>
      agent.on('session/load', (frame) =>
        agent.fail(frame, -32603, 'server unavailable', { errorName: 'ServerUnavailable' })
      )
  })
  await rig.acquire()
  expect(rig.openFailure()).toBeInstanceOf(AcpAgentError)
  expect(rig.openFailure()).toMatchObject({ data: { errorName: 'ServerUnavailable' } })
  expect(rig.sent('session/new')).toEqual([])
  expect(rig.sent('session/load')[0].params).toMatchObject({ sessionId: 'saved-id' })
  await rig.adapter.closeAll()
})
