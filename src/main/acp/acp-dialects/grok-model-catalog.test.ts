import { describe, expect, it } from 'vitest'
import model from '../fixtures/grok-v1-model.json'
import { grokModelEfforts } from './grok-model-catalog'

describe('Grok declared effort defaults', () => {
  it('uses the recorded model metadata before menu recommendations, without guessing', () => {
    // Grok 1.0.60 initialize capture, 2026-10-22; the model row is unchanged.
    expect(grokModelEfforts(model).declaredDefaultEffort).toBe('high')
    for (const [reasoningEffort, expected] of [
      ['xhigh', 'xhigh'],
      [undefined, 'high'],
      ['unlisted', null],
      [42, null]
    ]) {
      expect(
        grokModelEfforts({ _meta: { ...model._meta, reasoningEffort } }).declaredDefaultEffort
      ).toBe(expected)
      expect(grokModelEfforts({ _meta: { ...model._meta, reasoningEffort } }).defaultEffort).toBe(
        'high'
      )
    }
    const unmarked = model._meta.reasoningEfforts.map((entry) => ({ ...entry, default: false }))
    expect(
      grokModelEfforts({ _meta: { ...model._meta, reasoningEfforts: unmarked } })
        .declaredDefaultEffort
    ).toBe('high')
    expect(
      grokModelEfforts({
        _meta: { ...model._meta, reasoningEfforts: unmarked, reasoningEffort: undefined }
      }).declaredDefaultEffort
    ).toBeNull()
    expect(
      grokModelEfforts({ _meta: { supportsReasoningEffort: true, reasoningEffort: 'low' } })
        .declaredDefaultEffort
    ).toBe('low')
  })
})
