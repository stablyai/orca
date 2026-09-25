import { expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  USER_MESSAGE
} from './claude-structured-session-test-support'

it('publishes only same-session suggestions after a successful result and clears on dispatch', async () => {
  const claude = fakeClaude()
  const adapter = adapterFor(claude)
  const publish = vi.fn()
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'suggestion',
    events: {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish
    }
  })
  const message = (body: Record<string, unknown>): void => {
    claude.connections[0].handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...body })
  }
  const sessionId = identityFor().sessionId
  message({ type: 'prompt_suggestion', suggestion: 'too early' })
  expect(adapter.readPromptSuggestion(sessionId)).toBeNull()
  message({ type: 'result', is_error: false })
  publish.mockClear()
  message({ type: 'prompt_suggestion', suggestion: 'Add tests' })
  expect(adapter.readPromptSuggestion(sessionId)).toBe('Add tests')
  expect(publish).toHaveBeenCalledOnce()
  message({ type: 'prompt_suggestion', suggestion: 'Add tests' })
  message({ type: 'prompt_suggestion', suggestion: 123 })
  message({ type: 'prompt_suggestion', suggestion: 'foreign', session_id: 'other' })
  expect(publish).toHaveBeenCalledOnce()
  await adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'next', body: USER_MESSAGE })
  expect(adapter.readPromptSuggestion(sessionId)).toBeNull()
  message({ type: 'prompt_suggestion', suggestion: 'late previous turn' })
  expect(adapter.readPromptSuggestion(sessionId)).toBeNull()
  message({ type: 'result', is_error: true })
  message({ type: 'prompt_suggestion', suggestion: 'after error' })
  expect(adapter.readPromptSuggestion(sessionId)).toBeNull()
  await adapter.closeSession(sessionId)
})
