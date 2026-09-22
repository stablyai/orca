import { describe, expect, it, vi } from 'vitest'
import type { JournalPayloadRetention } from '../../native-chat/agent-session-journal/journal-payload-store'
import {
  retainClippedTranscriptText,
  workerTranscriptRetentionState
} from './worker-transcript-clip-retention'

function fakeRetention(): JournalPayloadRetention {
  return {
    retain: vi.fn(() => true),
    retrieve: vi.fn(() => null),
    retrieveRange: vi.fn(() => null),
    isReferencedBy: vi.fn(() => false)
  }
}

describe('retainClippedTranscriptText', () => {
  it('does not retain when no payloadScope is given, even with retention enabled', () => {
    const retention = fakeRetention()
    const state = workerTranscriptRetentionState({ retention })

    const { text, clipped } = retainClippedTranscriptText(state, 'the full text', 'the full…')

    expect(retention.retain).not.toHaveBeenCalled()
    expect(clipped.retrievable).toBe(false)
    expect(text).toBe('the full…')
  })

  it('retains and marks retrievable when a payloadScope is present', () => {
    const retention = fakeRetention()
    const state = workerTranscriptRetentionState({ retention, payloadScope: 'dispatch:123' })

    const { text, clipped } = retainClippedTranscriptText(state, 'the full text', 'the full…')

    expect(retention.retain).toHaveBeenCalledWith(clipped.digest, 'the full text', 'dispatch:123')
    expect(clipped.retrievable).toBe(true)
    expect(text).toBe(`the full… [full text ${clipped.byteLength} bytes, digest ${clipped.digest}]`)
  })

  it('does not retain when retention is null regardless of scope', () => {
    const state = workerTranscriptRetentionState({ retention: null, payloadScope: 'dispatch:123' })

    const { clipped } = retainClippedTranscriptText(state, 'the full text', 'the full…')

    expect(clipped.retrievable).toBe(false)
  })
})
