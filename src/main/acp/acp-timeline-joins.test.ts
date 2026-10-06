import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  GENERATION,
  messageText,
  openProviderTimelineRig,
  providerItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

describe('ACP joins through the assembler', () => {
  it('keeps provider message and tool ids apart across ACP sessions', async () => {
    const rig = await openProviderTimelineRig()
    for (const sessionId of ['session-a', 'session-b']) {
      const translator = new AcpTimelineTranslator({ sessionId })
      for (const update of [
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'same-message',
          content: { type: 'text', text: sessionId }
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'same-tool',
          title: sessionId,
          status: 'completed'
        }
      ]) {
        for (const event of translator.notification(
          'session/update',
          { sessionId, update },
          1100
        )) {
          expect(rig.assembler.apply(event).admission.accepted).toBe(true)
        }
      }
    }
    const rows = await rig.rows()
    expect(
      rows.filter((row) => row.body.kind === 'message').map((row) => messageText(row.body))
    ).toEqual(['session-a', 'session-b'])
    expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.name] : []))).toEqual([
      'session-a',
      'session-b'
    ])
  })

  it('keeps a request id a new child reuses apart from the old child', async () => {
    const rig = await openProviderTimelineRig()
    const params = {
      sessionId: 'provider-1',
      toolCall: { toolCallId: 'call-1', title: 'Run?' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    }
    const ask = () => {
      const translator = new AcpTimelineTranslator({ sessionId: 'provider-1' })
      for (const event of [
        ...translator.openPrompt('send-1', 1000).events,
        ...translator.request('session/request_permission', params, 0).events
      ]) {
        expect(rig.assembler.apply(event).admission.accepted).toBe(true)
      }
    }
    ask()
    await rig.restart()
    ask()
    const request = 'session/request_permission:0'
    const approvals = (await rig.rows()).filter((row) => row.body.kind === 'approval')
    expect(approvals.map((row) => row.itemId)).toEqual([
      providerItemId('request', request, { generation: GENERATION }),
      providerItemId('request', request, { generation: 'gen-2' })
    ])
    // The sweep cancelled the dead child's pending request; the new child's waits.
    expect(
      approvals.map((row) => row.body.kind === 'approval' && row.body.resolution.state)
    ).toEqual(['cancelled', 'pending'])
  })
})
