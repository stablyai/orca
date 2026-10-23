import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

async function genericRig() {
  const rig = await openProviderTimelineRig()
  const translator = new AcpTimelineTranslator({ sessionId: 'provider-1' })
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const update = (update: unknown) =>
    apply(translator.notification('session/update', { sessionId: 'provider-1', update }, 1100))
  return { rig, translator, apply, update }
}

// The protocol's enums are open: a value newer than this build reads as known and falls back.
describe('ACP values newer than this build', () => {
  it('keeps a tool with a newer kind or status as a tool row in its last known state', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Open page',
      kind: 'browse',
      status: 'pending'
    })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'paused' })
    const running = (await rig.rows()).find((row) => row.body.kind === 'tool-call')?.body
    expect(running).toMatchObject({ name: 'Open page', state: 'running' })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    const rows = (await rig.rows()).filter((row) => row.body.kind !== 'turn')
    expect(rows.map((row) => row.body)).toEqual([
      expect.objectContaining({ kind: 'tool-call', state: 'completed' })
    ])
  })

  it('reads a plan entry with a newer status or priority as not done', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    update({
      sessionUpdate: 'plan',
      entries: [{ content: 'Wait', status: 'blocked', priority: 'urgent' }]
    })
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    expect(
      (await rig.rows()).filter((row) => row.body.kind !== 'turn').map((row) => row.body)
    ).toEqual([expect.objectContaining({ presentation: 'plan-document', text: '- [ ] Wait' })])
  })

  it('ends a turn with a newer stop reason without inventing an outcome', async () => {
    const { rig, translator, apply } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    apply(translator.promptResult('send-1', { stopReason: 'paused_for_review' }, 1200))
    const [turn] = await rig.turns()
    expect(turn).toMatchObject({ state: 'completed' })
    expect(turn).not.toHaveProperty('outcome')
    expect((await rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([])
  })

  it('shows a permission the runtime could only partly read, with what it could read', async () => {
    const { rig, translator, apply } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    const request = translator.request(
      'session/request_permission',
      {
        sessionId: 'provider-1',
        toolCall: { toolCallId: 't1', title: 42 },
        options: [{ optionId: 'allow', kind: 'allow_for_project' }, { name: 'no id' }]
      },
      7
    )
    apply(request.events)
    expect(request.presentation?.body).toMatchObject({
      kind: 'approval',
      title: 'Permission requested',
      options: [{ id: 'allow', label: 'allow' }]
    })
    expect(request.presentation?.reply({ kind: 'option', optionId: 'allow' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })
    expect((await rig.rows()).map((row) => row.body.kind)).toEqual(['turn', 'approval'])
    expect(() =>
      translator.request(
        'session/request_permission',
        {
          sessionId: 'provider-1',
          toolCall: {},
          options: [{ optionId: 'allow', kind: 'allow_once' }]
        },
        8
      )
    ).toThrow('Invalid ACP permission request')
  })
})
