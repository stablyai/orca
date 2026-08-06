import { describe, expect, it } from 'vitest'
import {
  decodeNativeChatTranscriptLine,
  decodeNativeChatTurnLifecycle,
  nativeChatTranscriptAdapterForAgent
} from './native-chat-transcript-adapters'

describe('native chat transcript adapters', () => {
  it('shares Claude decoding with OpenClaude without sharing agent identity', () => {
    const claude = nativeChatTranscriptAdapterForAgent('claude')
    const openclaude = nativeChatTranscriptAdapterForAgent('openclaude')

    expect(claude).not.toBeNull()
    expect(openclaude).toBe(claude)
  })

  it('routes Codex records through its registered decoder', () => {
    const adapter = nativeChatTranscriptAdapterForAgent('codex')!
    const message = decodeNativeChatTranscriptLine(
      adapter,
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'adapter output' }]
        }
      }),
      'fallback-id'
    )

    expect(message).toMatchObject({ role: 'assistant' })
    expect(message?.blocks).toContainEqual({ type: 'text', text: 'adapter output' })
  })

  it('keeps line and lifecycle decoders in the same registered adapter', () => {
    const codex = nativeChatTranscriptAdapterForAgent('codex')!
    const grok = nativeChatTranscriptAdapterForAgent('grok')!
    const lifecycleLine = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' }
    })

    expect(decodeNativeChatTurnLifecycle(codex, lifecycleLine, 'fallback-id')).toMatchObject({
      state: 'working',
      turnId: 'turn-1'
    })
    expect(decodeNativeChatTurnLifecycle(grok, lifecycleLine, 'fallback-id')).toBeNull()
  })

  it('rejects agents without a transcript adapter', () => {
    expect(nativeChatTranscriptAdapterForAgent('cursor')).toBeNull()
    expect(nativeChatTranscriptAdapterForAgent(null)).toBeNull()
  })
})
