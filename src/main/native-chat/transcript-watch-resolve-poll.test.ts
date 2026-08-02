import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))
vi.mock('./transcript-watch-engine', () => ({
  getActiveNativeChatWatcherCount: vi.fn(() => 0),
  installTranscriptWatcher: mocks.install
}))

import { subscribeNativeChatTranscript } from './transcript-watch'

describe('native chat transcript resolve polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.install.mockReset().mockReturnValue(null)
    mocks.resolve.mockReset().mockResolvedValue(null)
  })

  afterEach(() => vi.useRealTimers())

  it('fast-probes an exact hook path without repeatedly scanning the session tree', async () => {
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session-id',
      transcriptPath: '/missing/exact.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.install.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_900)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)

    subscription.unsubscribe()
    const callsAfterUnsubscribe = mocks.install.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.install).toHaveBeenCalledTimes(callsAfterUnsubscribe)
  })

  it('keeps resolving on every retry when no exact hook path is available', async () => {
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session-id',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(35)
    expect(mocks.resolve.mock.calls.length).toBeGreaterThan(1)
    subscription.unsubscribe()
  })
})
