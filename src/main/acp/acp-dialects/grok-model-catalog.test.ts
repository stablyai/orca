import { describe, expect, it } from 'vitest'
import model from '../fixtures/grok-v1-model.json'
import { grokModelEfforts } from './grok-model-catalog'

describe('Grok declared effort defaults', () => {
  it('uses the recorded model metadata before menu recommendations, without guessing', () => {
    // Grok 1.0.60 initialize capture, 2026-10-22; the model row is unchanged.
    expect(grokModelEfforts(model).defaultEffort).toBe('high')
    for (const [reasoningEffort, expected] of [
      ['xhigh', 'xhigh'],
      [undefined, 'high'],
      ['unlisted', 'high']
    ]) {
      expect(grokModelEfforts({ _meta: { ...model._meta, reasoningEffort } }).defaultEffort).toBe(
        expected
      )
    }
    const unmarked = model._meta.reasoningEfforts.map((entry) => ({ ...entry, default: false }))
    expect(
      grokModelEfforts({ _meta: { ...model._meta, reasoningEfforts: unmarked } }).defaultEffort
    ).toBe('high')
    expect(
      grokModelEfforts({
        _meta: { ...model._meta, reasoningEfforts: unmarked, reasoningEffort: undefined }
      }).defaultEffort
    ).toBeUndefined()
    expect(
      grokModelEfforts({ _meta: { supportsReasoningEffort: true, reasoningEffort: 'low' } })
        .defaultEffort
    ).toBe('low')
  })
})
