import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { HarnessConversationDriverSink } from './driver'
import { emitClaudeAssistant, emitClaudeFinal, emitClaudeStreamDelta } from './claude-message'

const sink = {
  emit: vi.fn(),
  setProviderSessionId: vi.fn(),
  setConfiguration: vi.fn(),
  setContext: vi.fn(),
  setSubagents: vi.fn(),
  setTranscriptPath: vi.fn()
} satisfies HarnessConversationDriverSink

describe('emitClaudeAssistant', () => {
  beforeEach(() => sink.emit.mockClear())

  it('does not occupy the streaming assistant id with a thinking-only message', () => {
    emitClaudeAssistant(
      sink,
      {
        message: {
          id: 'provider-message',
          content: [{ type: 'thinking', thinking: 'Checking', signature: '' }]
        }
      } as SDKAssistantMessage,
      'claude:provider-message',
      new Map()
    )

    expect(sink.emit).toHaveBeenCalledOnce()
    expect(sink.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.completed',
        message: expect.objectContaining({ role: 'reasoning' })
      })
    )
  })

  it('streams assistant text before the successful result confirms it', () => {
    const texts = new Map<string, string>()
    emitClaudeStreamDelta(
      sink,
      { delta: { type: 'text_delta', text: 'Final answer' } },
      'fallback',
      'claude:message',
      texts
    )

    expect(sink.emit.mock.calls.map(([event]) => event.type)).toEqual([
      'message.started',
      'message.delta'
    ])
    expect(texts.get('claude:message')).toBe('Final answer')

    emitClaudeFinal(sink, 'claude:message', 'Final answer')
    expect(sink.emit.mock.calls.map(([event]) => event.type)).toEqual([
      'message.started',
      'message.delta',
      'message.completed'
    ])
    expect(sink.emit.mock.calls.at(-1)?.[0]).toMatchObject({
      message: { assistantPhase: 'final' }
    })
  })

  it('emits a canonical text-only assistant message without guessing its phase', () => {
    const texts = new Map<string, string>()
    emitClaudeAssistant(
      sink,
      {
        message: { id: 'provider-message', content: [{ type: 'text', text: 'Candidate' }] }
      } as SDKAssistantMessage,
      'claude:provider-message',
      texts
    )

    expect(sink.emit).toHaveBeenCalledWith({
      type: 'message.completed',
      message: expect.objectContaining({
        id: 'claude:provider-message',
        blocks: [{ type: 'text', text: 'Candidate' }]
      })
    })
    expect(sink.emit.mock.calls[0]?.[0].message).not.toHaveProperty('assistantPhase')
  })
})
