import { describe, expect, it } from 'vitest'
import { listedModels } from './claude-structured-model-catalog'

describe('listedModels', () => {
  it('names alias rows like the CLI names full-id rows, without the vendor', () => {
    const models = [
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku' },
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5-20260101[1m]', displayName: 'Opus' },
      { value: 'sonnet', resolvedModel: 'claude-3-5-sonnet-20241022', displayName: 'Sonnet' },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1' }
    ]
    expect(listedModels({ models }).map((model) => [model.id, model.label])).toEqual([
      ['claude-haiku-5-5', 'Haiku 5.5'],
      ['claude-opus-5-5-20260101[1m]', 'Opus 5.5 (1M context)'],
      ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
      ['claude-fable-5-1', 'Fable 5.1'],
      ['haiku', 'Haiku'],
      ['opus[1m]', 'Opus'],
      ['sonnet', 'Sonnet']
    ])
  })
})
