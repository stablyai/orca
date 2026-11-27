import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

describe('Claude transcript content whitespace', () => {
  it('keeps indented Markdown and trailing newlines in object text blocks', () => {
    const text = '    print("hello")\n    print("world")\n'
    const decode = (content: unknown) =>
      decodeClaudeTranscriptLine(
        JSON.stringify({ type: 'assistant', message: { content } }),
        'reply'
      )

    expect(decode([{ type: 'text', text }])?.blocks).toEqual(decode(text)?.blocks)
    expect(decode([{ type: 'thinking', thinking: text }])?.blocks).toEqual([{ type: 'text', text }])
    expect(decode([{ type: 'text', text: ' \n\t ' }])).toBeNull()
    expect(decode([{ type: 'text', text: 'ordinary reply' }])?.blocks).toEqual([
      { type: 'text', text: 'ordinary reply' }
    ])
  })

  it('preserves file indentation in structured tool output', () => {
    const output = '    return value\n'
    const decode = (content: unknown) =>
      decodeClaudeTranscriptLine(
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'read-file', content }]
          }
        }),
        'result'
      )

    expect(decode([{ type: 'text', text: output }])?.blocks).toEqual(decode(output)?.blocks)
    expect(decode({ text: output })?.blocks).toEqual(decode(output)?.blocks)
  })
})
