import { describe, expect, it } from 'vitest'
import { normalizeFullFirstUserPromptText } from './session-scanner-first-user-prompt'

// Mirrors FULL_FIRST_USER_PROMPT_SAFETY_LIMIT in the module under test.
const SAFETY_LIMIT = 256 * 1024

describe('AI Vault full first-user-prompt normalization', () => {
  it('drops an astral char straddling the safety limit instead of splitting it', () => {
    const result = normalizeFullFirstUserPromptText(`${'a'.repeat(SAFETY_LIMIT - 1)}😀tail`)

    expect(result).toHaveLength(SAFETY_LIMIT - 1)
    expect(result?.endsWith('a')).toBe(true)
    expect(hasUnpairedSurrogate(result ?? '')).toBe(false)
  })

  it('keeps a prompt shorter than the safety limit intact', () => {
    expect(normalizeFullFirstUserPromptText('ship it 😀')).toBe('ship it 😀')
  })
})

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isHigh = code >= 0xd800 && code <= 0xdbff
    const isLow = code >= 0xdc00 && code <= 0xdfff
    if (isHigh) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true
      }
      index += 1
      continue
    }
    if (isLow) {
      return true
    }
  }
  return false
}
