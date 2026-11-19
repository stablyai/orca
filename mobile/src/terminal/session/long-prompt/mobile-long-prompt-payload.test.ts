import { describe, expect, it } from 'vitest'
import { buildMobileLongPromptPayload } from './mobile-long-prompt-payload'

describe('buildMobileLongPromptPayload', () => {
  it('frames a multi-line draft and submits it once when the pane frames paste', () => {
    expect(buildMobileLongPromptPayload('first\nsecond', true)).toBe(
      '\u001b[200~first\rsecond\u001b[201~\r'
    )
  })

  it('normalizes line endings without framing when the pane does not frame paste', () => {
    expect(buildMobileLongPromptPayload('first\r\nsecond\nthird', false)).toBe(
      'first\rsecond\rthird\r'
    )
  })

  it('sends nothing for a whitespace-only draft', () => {
    expect(buildMobileLongPromptPayload('  \n\t ', true)).toBe('')
  })
})
