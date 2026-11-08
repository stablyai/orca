import { expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

it('keeps mixed content order and explicit types ahead of legacy tool shapes', () => {
  const message = decodeClaudeTranscriptLine(
    JSON.stringify({
      type: 'assistant',
      uuid: 'mixed',
      message: {
        role: 'assistant',
        content: [
          'first',
          { type: 'text', text: 'explicit', tool_use_id: 'not-a-result' },
          { type: 'thinking', thinking: 'reason', id: 'not-a-call', name: 'wrong', input: {} },
          { type: 'image', url: 'https://example.com/image.png', alt: 'diagram' },
          { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_result', content: ['one', { text: 'two' }], is_error: true },
          { type: 'server_tool_use', id: 'server', name: 'advisor', input: {} },
          {
            type: 'advisor_tool_result',
            tool_use_id: 'server',
            content: ['advice', { text: 'detail' }]
          },
          { type: 'unsupported' },
          null,
          ' ',
          { type: 'text', text: '' }
        ]
      }
    }),
    'fallback'
  )
  expect(message?.blocks).toEqual([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'explicit' },
    { type: 'text', text: 'reason' },
    { type: 'image-ref', url: 'https://example.com/image.png', alt: 'diagram' },
    { type: 'tool-call', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool-result', output: 'one\ntwo', isError: true },
    { type: 'tool-call', name: 'advisor', input: {}, callId: 'server' },
    { type: 'tool-result', callId: 'server', output: 'advice\ndetail' }
  ])
})
