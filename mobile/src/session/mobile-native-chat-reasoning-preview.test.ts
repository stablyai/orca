import { describe, expect, it } from 'vitest'
import { reasoningPreviewLine } from './mobile-native-chat-reasoning-preview'

describe('reasoningPreviewLine', () => {
  it('skips leading blank and whitespace-only lines', () => {
    expect(
      reasoningPreviewLine([{ type: 'text', text: '\n   \n\t\nLet me check the config first' }])
    ).toBe('Let me check the config first')
  })

  it('clips to 80 characters so a long first line cannot push out the row', () => {
    const preview = reasoningPreviewLine([{ type: 'text', text: 'x'.repeat(200) }])
    expect(preview).toHaveLength(80)
  })

  it('reads through non-text blocks to the first text block', () => {
    expect(
      reasoningPreviewLine([
        { type: 'image-ref', path: '/tmp/shot.png' },
        { type: 'text', text: 'after the image' }
      ])
    ).toBe('after the image')
  })

  it('returns empty for prose that is entirely blank', () => {
    expect(reasoningPreviewLine([{ type: 'text', text: '\n\n   \n' }])).toBe('')
  })

  it('returns empty when there are no blocks at all', () => {
    expect(reasoningPreviewLine([])).toBe('')
  })

  it('keeps the first line only, never bleeding the second line in', () => {
    expect(reasoningPreviewLine([{ type: 'text', text: 'first line\nsecond line' }])).toBe(
      'first line'
    )
  })
})
