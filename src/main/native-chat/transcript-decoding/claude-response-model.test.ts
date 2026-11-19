import { expect, it } from 'vitest'
import { decodeClaudeChatTranscriptLine } from './transcript-line-decoders-claude'

it('keeps the main assistant model and excludes synthetic and child replies', () => {
  const reply = (model: string, fields = {}) =>
    decodeClaudeChatTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        effort: 'high',
        message: { model, content: [{ type: 'text', text: 'Done' }] },
        ...fields
      }),
      'message'
    )

  expect(reply('claude-opus-5-5')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  for (const result of [
    reply('claude-haiku-5-5', { isSidechain: true }),
    reply('claude-haiku-5-5', { parent_tool_use_id: 'child-tool' }),
    reply('<synthetic>'),
    reply('claude-opus-5-5', { type: 'user' })
  ]) {
    expect(result?.model).toBeUndefined()
    expect(result?.effort).toBeUndefined()
  }
  expect(reply('claude-opus-5-5', { effort: 'invalid value' })?.effort).toBeUndefined()
})
