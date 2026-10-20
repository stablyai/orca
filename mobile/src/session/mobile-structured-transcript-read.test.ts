import { expect, it, vi } from 'vitest'
import { startMobileStructuredTranscriptRead } from './mobile-structured-transcript-read'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../src/shared/agent-session-current-requests-capability'
import type { AgentSessionCurrentRequestsMarker } from '../../../src/shared/agent-session-current-requests-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'

it.each([1, 2])(
  'reopens once after a rejected request and settles after %i failures',
  async (failures) => {
    const marker: AgentSessionCurrentRequestsMarker = {
      contract: AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
      sessionId: 's',
      epoch: 'e',
      publisher: 'host',
      revision: 1,
      owner: 'host:1',
      version: 'v1'
    }
    const frame = {
      type: 'batch' as const,
      sessionId: 's',
      fence: 1,
      batch: { cursor: { epoch: 'e', sequence: 1 }, items: [], removedItemIds: [], submissions: [] }
    }
    let state: StructuredAgentSessionState = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e',
      cursor: frame.batch.cursor
    }
    const callbacks: ((raw: unknown) => void)[] = []
    const closes = [vi.fn(), vi.fn()]
    let calls = 0
    const read = vi.fn(async () => {
      if (++calls <= failures) {
        throw new Error('Read interrupted')
      }
      return { marker, json: '[]', nextCursor: null }
    })
    const stop = startMobileStructuredTranscriptRead({
      sessionId: 's',
      read,
      isCurrent: () => true,
      applyQueued: vi.fn(),
      open: (callback) => {
        callbacks.push(callback)
        return closes[callbacks.length - 1] ?? vi.fn()
      },
      apply: (action) => {
        state = reduceStructuredAgentSession(state, action)
      },
      error: () => {
        state = reduceStructuredAgentSession(state, { type: 'error', message: 'Read interrupted' })
      }
    })
    callbacks[0]?.({ ...frame, currentRequests: marker })
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))
    expect(closes[0]).toHaveBeenCalledOnce()
    callbacks[0]?.(frame)
    expect(state.status).toBe('error')
    callbacks[1]?.({ ...frame, currentRequests: marker })
    if (failures === 1) {
      await vi.waitFor(() => expect(state.requestAuthority).toEqual(marker))
      expect(state.status).toBe('ready')
    } else {
      await vi.waitFor(() => expect(closes[1]).toHaveBeenCalledOnce())
      callbacks[1]?.(frame)
      expect(state.status).toBe('error')
      expect(state.requestAuthority).toBeUndefined()
    }
    expect(read).toHaveBeenCalledTimes(2)
    stop()
    callbacks[1]?.(frame)
    expect(read).toHaveBeenCalledTimes(2)
  }
)

function startStream() {
  const callbacks: ((raw: unknown) => void)[] = []
  const closes: ReturnType<typeof vi.fn>[] = []
  const errors: unknown[] = []
  const stop = startMobileStructuredTranscriptRead({
    sessionId: 's',
    read: vi.fn(),
    isCurrent: () => true,
    applyQueued: vi.fn(),
    open: (callback) => {
      callbacks.push(callback)
      const close = vi.fn()
      closes.push(close)
      return close
    },
    apply: vi.fn(),
    error: (error) => errors.push(error)
  })
  return { callbacks, closes, errors, stop }
}

const snapshotFrame = {
  type: 'snapshot',
  sessionId: 's',
  fence: 1,
  snapshot: { epoch: 'e', cursor: { epoch: 'e', sequence: 1 }, items: [], hasOlder: false }
}

it.each([
  ['an error', { type: 'error', message: 'Remote server disconnected' }],
  ['an end', { type: 'end' }]
])('reopens with backoff after %s frame while the chat stays open', (_, frame) => {
  vi.useFakeTimers()
  try {
    const { callbacks, closes, stop } = startStream()
    callbacks[0]?.(snapshotFrame)
    callbacks[0]?.(frame)
    expect(closes[0]).toHaveBeenCalledOnce()
    expect(callbacks).toHaveLength(1)
    vi.advanceTimersByTime(750)
    expect(callbacks).toHaveLength(2)
    // A reopen that fails again waits longer before the next one.
    callbacks[1]?.(frame)
    vi.advanceTimersByTime(750)
    expect(callbacks).toHaveLength(2)
    vi.advanceTimersByTime(750)
    expect(callbacks).toHaveLength(3)
    stop()
    callbacks[2]?.(frame)
    vi.advanceTimersByTime(60_000)
    expect(callbacks).toHaveLength(3)
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  ['an unknown method', { code: 'method_not_found', message: 'Unknown method' }],
  ['a forbidden method', { code: 'forbidden', message: 'forbidden' }],
  [
    'a corrupt journal',
    {
      code: 'agent_session_journal_unreadable',
      message: 'agent_session_journal_unreadable',
      data: {
        refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
      }
    }
  ]
])('stops reopening after %s refusal', (_, error) => {
  vi.useFakeTimers()
  try {
    const { callbacks, errors, stop } = startStream()
    callbacks[0]?.({ type: 'error', message: error.message, error })
    vi.advanceTimersByTime(60_000)
    expect(callbacks).toHaveLength(1)
    expect(errors).toHaveLength(1)
    stop()
  } finally {
    vi.useRealTimers()
  }
})

it('never reopens once the chat closed during the backoff', () => {
  vi.useFakeTimers()
  try {
    const { callbacks, stop } = startStream()
    callbacks[0]?.({ type: 'end' })
    stop()
    vi.advanceTimersByTime(60_000)
    expect(callbacks).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

it('retries soon again once a reopened stream delivered past its opening frame', () => {
  vi.useFakeTimers()
  try {
    const { callbacks } = startStream()
    callbacks[0]?.({ type: 'end' })
    vi.advanceTimersByTime(750)
    callbacks[1]?.({ type: 'end' })
    vi.advanceTimersByTime(1500)
    expect(callbacks).toHaveLength(3)
    callbacks[2]?.(snapshotFrame)
    callbacks[2]?.({ type: 'batch', sessionId: 's', fence: 1, batch: snapshotFrame.snapshot })
    callbacks[2]?.({ type: 'end' })
    vi.advanceTimersByTime(750)
    expect(callbacks).toHaveLength(4)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps doubling the wait when a reopen answers with a snapshot and then ends at once', () => {
  vi.useFakeTimers()
  try {
    const { callbacks } = startStream()
    callbacks[0]?.({ type: 'end' })
    vi.advanceTimersByTime(750)
    expect(callbacks).toHaveLength(2)
    callbacks[1]?.(snapshotFrame)
    callbacks[1]?.({ type: 'end' })
    vi.advanceTimersByTime(1499)
    expect(callbacks).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(callbacks).toHaveLength(3)
  } finally {
    vi.useRealTimers()
  }
})
