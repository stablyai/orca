import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeJournalBoundDelivery } from '../../../claude/structured/journal/claude-journal-bound-delivery'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'

// Perf contract (#45960): sizing each journal append and each pre-binding Claude event by serializing it
// allocated ~3.6 GB on main over a 100-chat burst. Sizing must not build the serialized form.
afterEach(() => {
  vi.restoreAllMocks()
})

const output = 'line of tool output with "quotes"\n'.repeat(4096)

it('sizes a journal item without serializing it', () => {
  const stringify = vi.spyOn(JSON, 'stringify')
  const bytes = estimateStructuredAgentSessionItemBytes(
    { kind: 'provider', providerItemId: 'tool-1' } as never,
    { kind: 'tool', output } as never
  )
  expect(stringify).not.toHaveBeenCalled()
  expect(bytes).toBe(152_157)
})

it('sizes a pending Claude event without serializing it', () => {
  const delivery = new ClaudeJournalBoundDelivery(undefined, () => false)
  const stringify = vi.spyOn(JSON, 'stringify')
  delivery.deliver(() => {}, { type: 'tool-result', output })
  expect(stringify).not.toHaveBeenCalled()
})
