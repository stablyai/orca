import { describe, expect, it } from 'vitest'
import { canCancelMobileStructuredPrompt } from './mobile-structured-prompt-cancellation'

describe('mobile structured prompt cancellation', () => {
  it('keeps stop available while a structured prompt awaits input without a live turn id', () => {
    expect(
      canCancelMobileStructuredPrompt({
        turnId: null,
        permission: { title: 'Allow?' },
        question: null
      })
    ).toBe(true)
    expect(
      canCancelMobileStructuredPrompt({
        turnId: null,
        permission: null,
        question: { text: 'Pick' }
      })
    ).toBe(true)
    expect(
      canCancelMobileStructuredPrompt({ turnId: null, permission: null, question: null })
    ).toBe(false)
  })
})
