import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor
} from '../session/testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const permission = (toolCallId: string) => ({
  sessionId: PROVIDER_SESSION,
  toolCall: { toolCallId, title: 'Write file' },
  options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
})

describe('Grok requests and the turn they belong to', () => {
  it('withdraws the card when the agent cancels its own permission request', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    const { agent } = rig.child()
    const asked = agent.request(11, 'session/request_permission', permission('call-11'))
    const approvals = async () =>
      (await rig.rig.rows()).filter((row) => row.body.kind === 'approval')
    await waitFor(async () => expect(await approvals()).toHaveLength(1))
    void agent.request(12, 'session/request_permission', permission('call-12')).catch(() => {})
    await waitFor(async () => expect(await approvals()).toHaveLength(2))
    agent.notify('$/cancel_request', { requestId: 11 })
    expect(await asked).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await waitFor(async () =>
      expect((await approvals()).map((row) => row.body)).toMatchObject([
        { resolution: { state: 'cancelled' } },
        { resolution: { state: 'pending' } }
      ])
    )
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
    expect((await approvals()).map((row) => row.body)).toMatchObject([
      { resolution: { state: 'cancelled' } },
      { resolution: { state: 'pending' } }
    ])
  })
})
