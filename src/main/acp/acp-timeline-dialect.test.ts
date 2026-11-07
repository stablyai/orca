import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

async function dialectRig() {
  const rig = await openProviderTimelineRig()
  const translator = new AcpTimelineTranslator({
    sessionId: 'provider-1',
    dialect: GROK_ACP_DIALECT
  })
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const notification = (method: string, params: unknown) =>
    apply(translator.notification(method, params, 1100))
  return { rig, translator, apply, notification }
}

describe('ACP dialect request and turn boundaries', () => {
  it('separates anonymous output across a suppressed user echo within one prompt', async () => {
    const { rig, translator, apply, notification } = await dialectRig()
    apply(translator.openPrompt('send-1', 1000).events)
    for (const [sessionUpdate, text] of [
      ['user_message_chunk', 'root echo'],
      ['agent_message_chunk', 'A'],
      ['user_message_chunk', 'followup echo'],
      ['agent_message_chunk', 'B']
    ]) {
      notification('session/update', {
        sessionId: 'provider-1',
        _meta: { promptId: 'prompt:send-1' },
        update: { sessionUpdate, content: { type: 'text', text } }
      })
    }
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    const messages = (await rig.rows()).flatMap((row) =>
      row.body.kind === 'message' ? [{ role: row.body.role, text: messageText(row.body) }] : []
    )
    expect(messages).toEqual([
      { role: 'assistant', text: 'A' },
      { role: 'assistant', text: 'B' }
    ])
    expect(await rig.turns()).toHaveLength(1)
  })

  it('preserves provider permission labels, validates selected ids, and keeps unanswered rows until withdrawn', async () => {
    const { rig, translator, apply } = await dialectRig()
    apply(translator.openPrompt('send-1', 1000).events)
    apply(
      translator.notification(
        'session/update',
        {
          sessionId: 'provider-1',
          _meta: { promptId: 'prompt:send-1' },
          update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Write example' }
        },
        1001
      )
    )
    const request = translator.request(
      'session/request_permission',
      {
        sessionId: 'provider-1',
        toolCall: { toolCallId: 'call-1', title: 'Write example' },
        options: [
          { optionId: 'custom-yes', name: 'Yes, once', kind: 'allow_once' },
          { optionId: 'custom-no', name: 'Keep the file', kind: 'reject_once' }
        ]
      },
      0
    )
    apply(request.events)
    expect(request.presentation?.body).toMatchObject({
      options: [
        { id: 'custom-yes', label: 'Yes, once' },
        { id: 'custom-no', label: 'Keep the file' }
      ]
    })
    expect(request.presentation?.reply(null)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(() => request.presentation?.reply({ kind: 'option', optionId: 'allow-once' })).toThrow(
      'offered option'
    )
    apply(translator.promptResult('send-1', { stopReason: 'cancelled' }, 1200))
    const approval = async () =>
      (await rig.rows()).find((row) => row.body.kind === 'approval')?.body
    expect(await approval()).toMatchObject({ resolution: { state: 'pending' } })
    const opened = request.events.find((event) => event.type === 'request.open')
    apply(
      opened?.type === 'request.open'
        ? [{ type: 'request.withdrawn', request: opened.request }]
        : []
    )
    expect(await approval()).toMatchObject({ resolution: { state: 'cancelled' } })
  })

  it('keeps client prompt settlement on the response, and never gives an autonomous turn invented success', async () => {
    const { rig, translator, apply, notification } = await dialectRig()
    apply(translator.openPrompt('send-1', 1000).events)
    notification('_x.ai/session_notification', {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt:send-1',
        stop_reason: 'end_turn'
      }
    })
    expect((await rig.turns())[0]!.state).toBe('running')
    apply(translator.promptResult('send-1', { stopReason: 'cancelled' }, 1200))
    notification('session/update', {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Autonomous' }
      },
      _meta: { promptId: 'task-completed-1' }
    })
    notification('_x.ai/session_notification', {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-1',
        stop_reason: 'future_stop'
      }
    })
    const turns = await rig.turns()
    expect(turns[0]!.outcome).toBe('cancellation')
    expect(turns[1]).toMatchObject({ state: 'completed' })
    expect(turns[1]).not.toHaveProperty('outcome')
  })

  it('keeps live autonomous output while suppressing marked replay during load', async () => {
    const { rig, translator, apply, notification } = await dialectRig()
    apply(translator.openPrompt('send-1', 1000).events)
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    await rig.rows()
    translator.beginLoad()
    notification('session/update', {
      sessionId: 'provider-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old' } },
      _meta: { isReplay: true, promptId: 'prompt:send-1' }
    })
    notification('session/update', {
      sessionId: 'provider-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live' } },
      _meta: { promptId: 'task-completed-live' }
    })
    notification('_x.ai/session_notification', {
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-live',
        stop_reason: 'end_turn'
      }
    })
    translator.finishLoad()
    expect(
      (await rig.rows()).flatMap((row) =>
        row.body.kind === 'message' ? [messageText(row.body)] : []
      )
    ).toEqual(['Live'])
    expect(await rig.turns()).toHaveLength(2)
  })
})
