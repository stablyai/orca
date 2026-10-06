import { applyPatch } from 'diff'
import { afterEach, describe, expect, it } from 'vitest'
import { contextTokensFromUsage } from '../../shared/agent-session-context-usage'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpAgentError } from './acp-errors'
import { AcpTimelineTranslator, acpTurnEnd } from './acp-timeline-translator'

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

  it('merges tool snapshots, bounds input/output and emits a separately keyed valid diff', async () => {
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
    // A settled journal row refuses a late provider update that says it is running again.
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' })
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    const body = (await rig.rows()).find(
      (row) => row.body.kind === 'tool-call' && row.body.callId === 'tool-1'
    )?.body
    expect(body).toMatchObject({
      name: 'edit_file',
      state: 'completed',
      input: { truncated: true },
      output: { truncated: true, byteLength: 40000 }
    })
    const diff = (await rig.rows()).find((row) => row.body.kind === 'diff')?.body
    if (diff?.kind !== 'diff') {
      throw new Error('Missing diff')
    }
    expect(diff.path).toBe('file.ts')
    expect(applyPatch(oldText, diff.patch.head)).toBe(newText)
  })

  it('keeps context occupancy from usage_update instead of aggregate prompt usage', async () => {
    const { rig, translator, apply, update } = await genericRig()
    apply(translator.openPrompt('send-1', 1000).events)
    update({ sessionUpdate: 'usage_update', used: 42, size: 100 })
    apply(
      translator.promptResult(
        'send-1',
        {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 50,
            outputTokens: 5,
            totalTokens: 55,
            cachedReadTokens: 20,
            cachedWriteTokens: 10
          }
        },
        1200
      )
    )
    const turn = (await rig.turns())[0]!
    expect(turn.contextUsage?.window).toEqual({ tokens: 100, capturedAt: 1100 })
    expect(turn.contextUsage?.used).toMatchObject({
      kind: 'estimate',
      usage: {
        inputTokens: 42,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0
      }
    })
    if (turn.contextUsage?.used?.kind !== 'estimate') {
      throw new Error('Missing usage')
    }
    expect(contextTokensFromUsage(turn.contextUsage.used.usage)).toBe(42)
  })

  it.each(['refusal', 'max_tokens', 'max_turn_requests'] as const)(
    'records %s as provider failure without an extra status row',
    async (stopReason) => {
      const { rig, translator, apply } = await genericRig()
      apply(translator.openPrompt('send-1', 1000).events)
      apply(translator.promptResult('send-1', { stopReason }, 1200))
      expect((await rig.turns())[0]).toMatchObject({ state: 'completed', outcome: 'failure' })
      expect(
        (await rig.rows()).some(
          (row) =>
            row.body.kind === 'status' && row.body.providerFrame?.kind === `prompt:${stopReason}`
        )
      ).toBe(false)
    }
  )

  it.each([
    [undefined, 'The agent ended this turn with an error.'],
    ['Agent X', 'Agent X ended this turn with an error.']
  ])(
    "writes a failed turn row in the agent's words, or names the agent (%s) without any",
    async (agentName, fallback) => {
      const { rig, translator, apply } = await genericRig(agentName ? { agentName } : {})
      apply(translator.openPrompt('send-1', 1000).events)
      apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1100))
      apply(translator.openPrompt('send-2', 1200).events)
      apply(translator.promptFailed('send-2', new AcpAgentError(-32603, 'Upstream failed'), 1300))
      apply(translator.openPrompt('send-3', 1400).events)
      apply(translator.promptFailed('send-3', new AcpAgentError(-32603, ''), 1500))
      const rows = (await rig.rows()).filter((row) => row.body.kind === 'status')
      expect(rows.map((row) => row.body)).toEqual([
        { kind: 'status', tone: 'error', text: 'Upstream failed' },
        { kind: 'status', tone: 'error', text: fallback }
      ])
      expect((await rig.turns()).map((turn) => turn.outcome)).toEqual([
        'success',
        'failure',
        'failure'
      ])
    }
  )

  it('keeps unknown verdicts unknown and preserves unknown frames without opening a turn', async () => {
    const { rig, translator, apply } = await genericRig()
    expect(acpTurnEnd('turn', 'future_stop', 1200)).not.toHaveProperty('outcome')
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
  })

  it('ignores live user echoes and options metadata, and rejects cross-session requests', async () => {
    const { rig, translator, update } = await genericRig()
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })
    update({ sessionUpdate: 'available_commands_update', availableCommands: [] })
    expect(await rig.rows()).toEqual([])
    expect(
      translator.notification(
        'session/update',
        {
          sessionId: 'other',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'other' } }
        },
        1100
      )
    ).toEqual([])
    expect(() =>
      translator.request('session/request_permission', { sessionId: 'other' }, 0)
    ).toThrow('unknown session')
    expect(translator.request('future/request', { sessionId: 'provider-1' }, 0)).toMatchObject({
      events: [{ type: 'provider.frame' }]
    })
  })

  it('drops unmarked load history, except context usage', () => {
    const translator = new AcpTimelineTranslator({ sessionId: 'provider-1' })
    translator.beginLoad()
    const events = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'User' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History' } },
      { sessionUpdate: 'tool_call', toolCallId: 'old-tool', title: 'Read', status: 'completed' },
      { sessionUpdate: 'usage_update', used: 5000, size: 256000 }
    ].flatMap((update) =>
      translator.notification('session/update', { sessionId: 'provider-1', update }, 1100)
    )
    expect(events).toEqual([
      expect.objectContaining({ type: 'context.usage', join: { thread: 'provider-1' } })
    ])
  })

  it('drops marked replay outside a load and uses typed standard events', async () => {
    const { rig, translator, apply } = await genericRig()
    expect(
      translator.notification(
        'session/update',
        {
          sessionId: 'provider-1',
          _meta: { isReplay: true },
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'History' }
          }
        },
        1100
      )
    ).toEqual([])
    apply(translator.openPrompt('send-1', 1000).events)
    apply(
      translator.sessionEvent(
        {
          kind: 'known',
          notification: {
            sessionId: 'provider-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'typed' }
            }
          }
        },
        1100
      )
    )
    apply(translator.promptResult('send-1', { stopReason: 'end_turn' }, 1200))
    expect((await rig.rows()).some((row) => messageText(row.body) === 'typed')).toBe(true)
  })
  it('evicts completed snapshots during long turns while preserving active tool input', async () => {
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
