import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { StatusPillBroadcaster } from './status-pill-broadcaster'

function makeEntry(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    receivedAt: 0,
    stateStartedAt: 0,
    paneKey: 'tab:leaf',
    connectionId: null,
    ...overrides
  } as AgentStatusIpcPayload
}

function makeHarness() {
  const sent: { summary: unknown; rows: unknown[] }[] = []
  const scheduler = vi.fn<(cb: () => void, ms: number) => ReturnType<typeof setTimeout>>((cb) =>
    setTimeout(cb, 0)
  )
  const clearScheduler = vi.fn<(h: ReturnType<typeof setTimeout>) => void>((h) => clearTimeout(h))
  const getSnapshot = vi.fn<() => AgentStatusIpcPayload[]>(() => [])
  const broadcaster = new StatusPillBroadcaster({
    getSnapshot,
    send: (payload) => sent.push(payload),
    now: () => 0,
    scheduler,
    clearScheduler
  })
  return { broadcaster, sent, scheduler, clearScheduler, getSnapshot }
}

describe('StatusPillBroadcaster', () => {
  it('flushNow sends a summary computed from the snapshot', () => {
    const harness = makeHarness()
    harness.getSnapshot.mockReturnValue([makeEntry({ state: 'working', paneKey: 'a' })])
    harness.broadcaster.flushNow()
    expect(harness.sent).toHaveLength(1)
    const summary = harness.sent[0]?.summary as { working: number }
    expect(summary.working).toBe(1)
    const rows = harness.sent[0]?.rows as { paneKey: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.paneKey).toBe('a')
  })

  it('scheduleBroadcast starts one coalesce timer and flushes once', () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.getSnapshot.mockReturnValue([
        makeEntry({ state: 'working', paneKey: 'a', prompt: 'first' })
      ])
      harness.broadcaster.scheduleBroadcast()
      harness.broadcaster.scheduleBroadcast()
      harness.broadcaster.scheduleBroadcast()
      expect(harness.scheduler).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      expect(harness.sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-send when neither counts nor label nor rows changed', () => {
    const harness = makeHarness()
    harness.getSnapshot.mockReturnValue([makeEntry({ state: 'working', paneKey: 'a' })])
    harness.broadcaster.flushNow()
    harness.broadcaster.flushNow()
    expect(harness.sent).toHaveLength(1)
  })

  it('re-sends when the activity label changes', () => {
    const harness = makeHarness()
    harness.getSnapshot.mockReturnValueOnce([
      makeEntry({ state: 'working', paneKey: 'a', prompt: 'first' })
    ])
    harness.broadcaster.flushNow()
    harness.getSnapshot.mockReturnValueOnce([
      makeEntry({ state: 'working', paneKey: 'a', prompt: 'second' })
    ])
    harness.broadcaster.flushNow()
    expect(harness.sent).toHaveLength(2)
  })

  it('swallows snapshot errors without throwing', () => {
    const harness = makeHarness()
    harness.getSnapshot.mockImplementation(() => {
      throw new Error('snapshot unavailable')
    })
    expect(() => harness.broadcaster.flushNow()).not.toThrow()
    expect(harness.sent).toHaveLength(0)
  })

  it('destroy stops pending timers and makes scheduleBroadcast a no-op', () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      harness.getSnapshot.mockReturnValue([makeEntry({ state: 'working', paneKey: 'a' })])
      harness.broadcaster.scheduleBroadcast()
      expect(harness.scheduler).toHaveBeenCalledTimes(1)
      harness.broadcaster.destroy()
      vi.advanceTimersByTime(1000)
      expect(harness.sent).toHaveLength(0)
      expect(harness.clearScheduler).toHaveBeenCalled()
      harness.broadcaster.scheduleBroadcast()
      // Why: no second call after destroy — the broadcaster is now a no-op.
      expect(harness.scheduler).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
