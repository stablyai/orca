import { afterEach, expect, it, vi } from 'vitest'
import { createTerminalPromptSuggestionReads } from './terminal-prompt-suggestion-reads'

afterEach(() => vi.useRealTimers())

it('routes replies by request and ignores old or unrelated replies', async () => {
  const reader = createTerminalPromptSuggestionReads()
  const post = vi.fn()
  const first = reader.read(post)
  const second = reader.read(post)
  expect(reader.receive({ type: 'ready' })).toBe(false)
  reader.receive({ type: 'prompt-suggestion', requestId: 2, text: 'Second' })
  reader.receive({ type: 'prompt-suggestion', requestId: 1, text: 'First' })
  expect(await first).toBe('First')
  expect(await second).toBe('Second')
  reader.receive({ type: 'prompt-suggestion', requestId: 1, text: 'Stale' })
})

it('settles reads on document reset, timeout and transport failure', async () => {
  vi.useFakeTimers()
  const reader = createTerminalPromptSuggestionReads()
  const reset = reader.read(() => {})
  reader.clear()
  expect(await reset).toBeNull()
  const timeout = reader.read(() => {})
  await vi.advanceTimersByTimeAsync(1_500)
  expect(await timeout).toBeNull()
  expect(
    await reader.read(() => {
      throw new Error('gone')
    })
  ).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})
