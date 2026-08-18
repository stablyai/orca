import { describe, expect, it } from 'vitest'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession
} from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'

// Mirrors SESSION_PREVIEW_MESSAGE_LIMIT in the module under test.
const PREVIEW_LIMIT = 5

function accumulatorWithUserTurns(count: number): SessionAccumulator {
  const accumulator = createAccumulator({
    agent: 'claude',
    file: { path: '/tmp/session-1.jsonl', mtimeMs: 0, modifiedAt: new Date(0).toISOString() },
    sessionId: 'session-1'
  })
  for (let index = 0; index < count; index += 1) {
    addPreviewMessage(accumulator, { role: 'user', text: `turn ${index}` })
  }
  return accumulator
}

describe('AI Vault preview-window truncation signal', () => {
  it('leaves the flag off while the window still holds the whole transcript', () => {
    const session = finalizeSession(accumulatorWithUserTurns(PREVIEW_LIMIT), 'darwin')

    expect(session?.previewMessages).toHaveLength(PREVIEW_LIMIT)
    expect(session?.previewMessagesTruncated).toBeUndefined()
  })

  it('flags the session once an older turn falls out of the window', () => {
    const session = finalizeSession(accumulatorWithUserTurns(PREVIEW_LIMIT + 1), 'darwin')

    // The opening ask is gone, so the earliest preview turn is not the first prompt.
    expect(session?.previewMessages[0]?.text).toBe('turn 1')
    expect(session?.previewMessagesTruncated).toBe(true)
  })

  it('carries the flag onto snapshots taken from a cloned accumulator', () => {
    const accumulator = accumulatorWithUserTurns(PREVIEW_LIMIT + 1)

    expect(finalizeSession({ ...accumulator }, 'darwin')?.previewMessagesTruncated).toBe(true)
  })
})
