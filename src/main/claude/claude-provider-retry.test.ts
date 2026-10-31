import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeTransientFailure } from './claude-result-outcome'
import { adapterFor, fakeClaude, identityFor } from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'

it('declines the recorded Claude authentication failure and untyped usage failures', () => {
  const capture: { frame?: Record<string, unknown> }[] = readFileSync(
    join(__dirname, '__fixtures__/claude-lifecycle-capture-auth-failed.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const errors = capture.flatMap((row) =>
    row.frame && (row.frame.type === 'result' || row.frame.type === 'assistant') ? [row.frame] : []
  )
  expect(errors.length).toBeGreaterThan(0)
  for (const frame of errors) {
    expect(claudeTransientFailure(frame)).toBeUndefined()
  }
  expect(claudeTransientFailure({ api_error: 'usage_limit_reached' })).toBeUndefined()
})

it('accepts a fresh hidden Claude replay without a user message body', async () => {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const appendItem = vi.fn()
  const adapter = adapterFor(claude, {}, events)
  try {
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'retry-test',
      events: { appendItem, appendTombstone: () => {}, publish: () => {} }
    })
    const result = await adapter.continueAfterTransientFailure({
      sessionId: 'session-1',
      fence: 7,
      admitFreshInput: async (enqueue) => enqueue('ask', false),
      signal: new AbortController().signal
    })
    expect(result).toMatchObject({ state: 'started' })
    const sent = claude.connections[0].sent.find((frame) => frame.type === 'user')!
    expect(sent).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Please continue.' }] }
    })
    expect(sent.uuid).toEqual(expect.any(String))
    expect(events.some((event) => event.type === 'message' && event.startsTurn)).toBe(true)
    expect(appendItem.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ kind: 'message', role: 'user' })
    )
  } finally {
    await adapter.closeAll()
  }
})
