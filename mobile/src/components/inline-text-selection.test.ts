import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

const { INLINE_TEXT_SELECTION, inlineTextSelectionAllowed } =
  await import('./inline-text-selection')

describe('inline text selection policy', () => {
  it('keeps inline selection everywhere but Android', () => {
    expect(inlineTextSelectionAllowed('ios')).toBe(true)
    expect(inlineTextSelectionAllowed('web')).toBe(true)
    expect(inlineTextSelectionAllowed('android')).toBe(false)
  })

  it('resolves the running platform once', () => {
    expect(INLINE_TEXT_SELECTION).toBe(false)
  })
})
