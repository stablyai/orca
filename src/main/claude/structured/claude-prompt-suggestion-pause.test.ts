import { describe, expect, it, vi } from 'vitest'
import {
  claudePromptSuggestionPause,
  readyClaudePromptSuggestionPause,
  syncClaudePromptSuggestionPause
} from './claude-prompt-suggestion-pause'

function session(enabled: boolean) {
  const setPromptSuggestionsPaused = vi.fn(async (_paused: boolean) => {})
  const value = {
    connection: { setPromptSuggestionsPaused },
    promptSuggestionPause: enabled ? claudePromptSuggestionPause() : undefined
  }
  return { value, sent: setPromptSuggestionsPaused.mock.calls }
}

describe('pausing Claude prompt suggestions', () => {
  it('pauses a new process nobody reads, then follows readers once it has started', () => {
    const { value, sent } = session(true)
    syncClaudePromptSuggestionPause(value, false)
    expect(sent).toEqual([])

    readyClaudePromptSuggestionPause(value, false)
    syncClaudePromptSuggestionPause(value, true)
    syncClaudePromptSuggestionPause(value, true)
    expect(sent).toEqual([[true], [false]])
  })

  it('sends nothing to a process a reader already watches, or one launched without suggestions', () => {
    const watched = session(true)
    readyClaudePromptSuggestionPause(watched.value, true)
    const old = session(false)
    readyClaudePromptSuggestionPause(old.value, false)
    syncClaudePromptSuggestionPause(old.value, true)
    expect([...watched.sent, ...old.sent]).toEqual([])
  })
})
