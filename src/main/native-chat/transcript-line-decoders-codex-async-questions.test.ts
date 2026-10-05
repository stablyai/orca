import { describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

const questions = [{ title: 'Which color?', options: ['Red', 'Blue'] }]

describe('Codex async question decoding', () => {
  it('keeps the questions and call id of a paginated-mode completed item', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'call-7',
            content: [{ type: 'Text', text: 'Which color?\n- Red\n- Blue' }],
            phase: 'final_answer',
            delivery: 'async',
            questions
          }
        }
      }),
      'fallback'
    )
    expect(message).toMatchObject({
      id: 'call-7',
      role: 'assistant',
      blocks: [{ type: 'text', asyncQuestions: { providerItemId: 'call-7', questions } }]
    })
  })

  it('keeps the questions of a legacy-mode agent_message, which has no item id', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Which color?', delivery: 'async', questions }
      }),
      '/rollout.jsonl:0000000000000123'
    )
    expect(message).toMatchObject({
      id: '/rollout.jsonl:0000000000000123',
      blocks: [{ type: 'text', text: 'Which color?', asyncQuestions: { questions } }]
    })
    expect(message?.blocks[0]).not.toHaveProperty('asyncQuestions.providerItemId')
  })

  it('leaves ordinary agent messages unchanged', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
      'f'
    )
    expect(message?.blocks).toEqual([{ type: 'text', text: 'hi' }])
  })
})
