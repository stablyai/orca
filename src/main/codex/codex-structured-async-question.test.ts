import { describe, expect, it } from 'vitest'
import { extractPendingAsk } from '../../shared/native-chat/input/native-chat-ask'
import { codexItemBody } from './codex-structured-item-translation'

describe('Codex async question items', () => {
  it('carries an async question on its message so clients can answer it', () => {
    const body = codexItemBody({
      type: 'agentMessage',
      id: 'call-async',
      text: 'Which color?\n- Red\n- Blue',
      phase: 'final_answer',
      delivery: 'async',
      questions: [
        { title: 'Which color?', options: ['Red', 'Blue'] },
        { title: 'Why?', options: null }
      ]
    })
    const blocks = body?.kind === 'message' ? body.blocks : []

    expect(blocks[0]).toEqual({ type: 'text', text: 'Which color?\n- Red\n- Blue' })
    expect(
      extractPendingAsk([
        { id: 'm', role: 'assistant', blocks, timestamp: null, source: 'transcript' }
      ])
    ).toEqual({
      replyAsMessage: true,
      questions: [
        {
          question: 'Which color?',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        },
        { question: 'Why?', multiSelect: false, options: [] }
      ]
    })
  })
})
