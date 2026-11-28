import { describe, expect, it } from 'vitest'
import { readPromptSuggestionText } from './agent-session-prompt-suggestion-text'

describe('readPromptSuggestionText', () => {
  it('drops a JSON payload a sampler sends for no guess', () => {
    expect(readPromptSuggestionText(' {"suggestion": null}\n')).toBeNull()
  })

  it('keeps a prompt that only contains braces or brackets', () => {
    expect(readPromptSuggestionText('{x} still fails, fix the [WIP] test')).toBe(
      '{x} still fails, fix the [WIP] test'
    )
  })
})
