import { applyPatch } from 'diff'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

async function genericRig(options: { agentName?: string } = {}) {
  const rig = await openProviderTimelineRig()
  const translator = new AcpTimelineTranslator({ sessionId: 'provider-1', ...options })
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const update = (update: unknown) =>
    apply(translator.notification('session/update', { sessionId: 'provider-1', update }, 1100))
  return { rig, translator, apply, update }
}

describe('generic ACP translation', () => {
  it('keeps named text across non-text barriers, splits anonymous text, and assembles reasoning', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'First ' }
    })
    update({
      sessionUpdate: 'plan',
      entries: [{ content: 'Read', status: 'pending', priority: 'medium' }]
    })
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'reply' }
    })
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before' } })
    update({
      sessionUpdate: 'plan',
      entries: [{ content: 'Read', status: 'completed', priority: 'medium' }]
    })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'After' } })
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    const rows = await rig.rows()
    expect(
      rows.flatMap((row) => (row.body.kind === 'message' ? [messageText(row.body)] : []))
    ).toEqual(['First reply', 'Thinking', 'Before', 'After'])
    expect(rows.find((row) => messageText(row.body) === 'Thinking')?.body).toMatchObject({
      role: 'reasoning'
    })
    expect(
      rows.flatMap((row) =>
        row.body.kind === 'status' && row.body.presentation === 'plan-document'
          ? [row.body.text]
          : []
      )
    ).toEqual(['- [x] Read'])
  })

  it('merges tool snapshots, settles input and output whole and keys a valid diff', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    const oldText = 'same\nbefore\n'
    const newText = 'same\nafter\n'
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Edit',
      name: 'edit_file',
      rawInput: { text: 'x'.repeat(40000) },
      status: 'pending'
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'progress' } }]
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'y'.repeat(40000) } },
        { type: 'diff', path: 'file.ts', oldText, newText }
      ]
    })
    // Settled journal rows reject late updates that try to reopen them.
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' })
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    const body = (await rig.rows()).find(
      (row) => row.body.kind === 'tool-call' && row.body.callId === 'tool-1'
    )?.body
    expect(body).toMatchObject({
      name: 'edit_file',
      state: 'completed',
      // Preserve full input supplied only during the running state.
      input: { text: 'x'.repeat(40000) },
      output: { head: 'y'.repeat(40000), truncated: false, byteLength: 40000 }
    })
    const diff = (await rig.rows()).find((row) => row.body.kind === 'diff')?.body
    if (diff?.kind !== 'diff') {
      throw new Error('Missing diff')
    }
    expect(diff.path).toBe('file.ts')
    expect(applyPatch(oldText, diff.patch.head)).toBe(newText)
  })

  it('bounds unknown frames without opening a turn and leaves unknown stop outcomes unset', async () => {
    const { rig, translator, apply } = await genericRig()
    apply(
      translator.sessionEvent(
        {
          kind: 'unrecognized',
          sessionId: 'provider-1',
          raw: {
            sessionId: 'provider-1',
            update: { sessionUpdate: 'future_event', secret: 'z'.repeat(40000) }
          }
        },
        1100
      )
    )
    const rows = await rig.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toMatchObject({
      kind: 'status',
      providerFrame: { payload: { truncated: true } }
    })
    expect(rows[0]!.turnScope).toEqual({ kind: 'thread' })
    expect(await rig.turns()).toEqual([])
    apply(translator.openPrompt('future', 1200).events)
    apply(translator.promptResult('future', { stopReason: 'future_stop' }, 1300))
    const [turn] = await rig.turns()
    expect(turn).toMatchObject({ state: 'completed' })
    expect(turn).not.toHaveProperty('outcome')
  })

  it('preserves active tool input during long turns with many completed snapshots', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'active',
      title: 'Active',
      rawInput: { important: true }
    })
    for (let index = 0; index < 140; index += 1) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: `done-${index}`,
        title: 'Read',
        status: 'pending'
      })
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: `done-${index}`,
        status: 'completed'
      })
      await rig.rows()
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'active', status: 'failed' })
    apply(translator.promptResult('send-1', { stopReason: 'cancelled' }, 1200))
    expect(
      (await rig.rows()).find(
        (row) => row.body.kind === 'tool-call' && row.body.callId === 'active'
      )?.body
    ).toMatchObject({
      name: 'Active',
      input: { important: true },
      state: 'failed'
    })
    expect(
      (await rig.rows()).filter(
        (row) => row.body.kind === 'tool-call' && row.body.state === 'completed'
      )
    ).toHaveLength(140)
  })

  it('keeps a valid replacement patch when a diff exceeds the edit-search budget', async () => {
    const { rig, update } = await genericRig()
    const oldText = Array.from({ length: 520 }, (_, index) => `old-${index}\n`).join('')
    const newText = Array.from({ length: 520 }, (_, index) => `new-${index}\n`).join('')
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit',
      title: 'Edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'file.ts', oldText, newText }]
    })
    const body = (await rig.rows()).find((row) => row.body.kind === 'diff')?.body
    if (body?.kind !== 'diff') {
      throw new Error('Missing diff')
    }
    expect(body.patch.truncated).toBe(false)
    expect(applyPatch(oldText, body.patch.head)).toBe(newText)
  })
})
