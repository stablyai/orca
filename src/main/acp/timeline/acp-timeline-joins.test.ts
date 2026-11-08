import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
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
})
