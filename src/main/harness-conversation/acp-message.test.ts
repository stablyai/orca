import { describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'
import { acpPlanMessage, acpTextMessageId, acpUsageContext, emitAcpTextChunk } from './acp-message'

describe('acpTextMessageId', () => {
  it('keeps provider ids and isolates turns without one', () => {
    expect(acpTextMessageId('assistant', 'provider', 'turn-a')).toBe(
      'acp:assistant:provider:turn-a'
    )
    expect(acpTextMessageId('assistant', undefined, 'turn-b')).toBe('acp:assistant:message:turn-b')
  })

  it('projects stable plan and usage updates', () => {
    expect(
      acpPlanMessage(
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'Inspect', priority: 'high', status: 'in_progress' }]
        },
        'turn'
      )
    ).toMatchObject({
      id: 'acp:plan:turn',
      role: 'reasoning',
      blocks: [{ text: '- [ ] Inspect' }]
    })
    expect(acpUsageContext({ sessionUpdate: 'usage_update', used: 25, size: 100 })).toMatchObject({
      usedTokens: 25,
      remainingTokens: 75,
      usedPercent: 25
    })
  })

  it('streams both visible text and thought without guessing a final phase', () => {
    const emit = vi.fn()
    const sink = {
      emit,
      setProviderSessionId: vi.fn(),
      setConfiguration: vi.fn(),
      setContext: vi.fn(),
      setSubagents: vi.fn(),
      setTranscriptPath: vi.fn()
    } satisfies HarnessConversationDriverSink
    const texts = new Map<string, { role: 'assistant' | 'reasoning'; text: string }>()

    emitAcpTextChunk(
      sink,
      texts,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'candidate' } },
      'turn'
    )
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'message.started',
      'message.delta'
    ])

    emitAcpTextChunk(
      sink,
      texts,
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      'turn'
    )
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'message.started',
      'message.delta',
      'message.started',
      'message.delta'
    ])
  })
})
