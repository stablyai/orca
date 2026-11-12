import { describe, expect, it } from 'vitest'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

describe('Claude transcript response models', () => {
  it('preserves the model that produced an assistant response after the terminal banner is gone', () => {
    const response = decodeClaudeTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'response',
        message: {
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'Finished the change.' }]
        }
      }),
      'fallback'
    )

    expect(response?.model).toBe('claude-opus-5-5')
  })

  it.each([
    ['assistant', '<synthetic>'],
    ['assistant', undefined],
    ['assistant', 42],
    ['assistant', '  '],
    ['user', 'claude-opus-5-5']
  ])('does not attribute a model from a %s record with model %s', (role, model) => {
    const response = decodeClaudeTranscriptLine(
      JSON.stringify({
        type: role,
        uuid: 'not-a-model-response',
        message: { role, model, content: [{ type: 'text', text: 'A local message.' }] }
      }),
      'fallback'
    )

    expect(response?.model).toBeUndefined()
  })

  it.each([{ isSidechain: true }, { parent_tool_use_id: 'parent-call' }, { agentId: 'worker' }])(
    'does not expose a child response model as parent-session evidence (%j)',
    (provenance) => {
      const response = decodeClaudeTranscriptLine(
        JSON.stringify({
          type: 'assistant',
          uuid: 'child-response',
          ...provenance,
          message: {
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: 'Child result.' }]
          }
        }),
        'fallback'
      )

      expect(response?.model).toBeUndefined()
    }
  )
})
