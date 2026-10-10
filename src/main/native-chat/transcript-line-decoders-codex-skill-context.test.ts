import { describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

describe('Codex transcript skill context', () => {
  it.each(['message', 'response_item'])(
    'preserves prompt text and images beside a skill expansion in %s',
    (type) => {
      const message = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this image' },
          { type: 'text', text: '<skill>\nInstructions\n</skill>' },
          { type: 'image', url: 'https://example.test/image.png' }
        ]
      }
      const record = type === 'message' ? message : { type, payload: message }
      expect(decodeCodexTranscriptLine(JSON.stringify(record), 'mixed')?.blocks).toEqual([
        { type: 'text', text: 'Inspect this image' },
        { type: 'image-ref', url: 'https://example.test/image.png' }
      ])
    }
  )

  it('preserves an authoritative user event containing a literal skill wrapper', () => {
    const text = '<skill>Explain this XML</skill>'
    expect(
      decodeCodexTranscriptLine(
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }),
        'submitted'
      )?.blocks
    ).toEqual([{ type: 'text', text }])
  })

  it.each(['<skill>', ' \n<SKILL>'])(
    'drops expanded skill response items beginning with %j',
    (prefix) => {
      const message = {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: `${prefix}\n<name>example</name>\nInstructions\n</skill>` }]
      }
      for (const record of [message, { type: 'response_item', payload: message }]) {
        expect(decodeCodexTranscriptLine(JSON.stringify(record), 'context')).toBeNull()
      }
    }
  )

  it.each(['$example', 'Explain <skill> tags', '<skillset>user XML</skillset>'])(
    'preserves the actual user prompt %j',
    (text) => {
      expect(
        decodeCodexTranscriptLine(
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text }]
            }
          }),
          'user'
        )?.blocks
      ).toEqual([{ type: 'text', text }])
    }
  )

  it('preserves assistant explanations containing the skill wrapper', () => {
    expect(
      decodeCodexTranscriptLine(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '<skill>example</skill>' }]
          }
        }),
        'assistant'
      )?.role
    ).toBe('assistant')
  })
})
