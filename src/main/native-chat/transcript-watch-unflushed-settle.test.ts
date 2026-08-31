import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'

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
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

type Snapshot = [NativeChatMessage[], boolean, number, string | undefined]

const realPlatform = process.platform

function subscribeCollecting(
  snapshots: Snapshot[],
  onTranscriptPending: () => void = () => {}
): Promise<{ unsubscribe: () => void }> {
  return subscribeNativeChatTranscript({
    agent: 'claude',
    sessionId: 'session-id',
    transcriptPath: '/projects/p/session-id.jsonl',
    resolvePollIntervalMs: 10,
    onAppend: () => {},
    onTranscriptPending,
    onInitialSnapshot: (messages, hasMore, beforeOffset, error) => {
      snapshots.push([messages, hasMore, beforeOffset, error])
    }
  })
}

// A brand-new agent session flushes its first JSONL line seconds to minutes
// after start — and never at all until it is prompted. Emitting nothing in that
// window leaves every client on an unexplained spinner (mobile native chat
// renders `status === 'loading'` as a bare ActivityIndicator).
describe('unflushed transcript settles the view', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.install.mockReset().mockResolvedValue(null)
    mocks.resolve.mockReset().mockResolvedValue(null)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.useRealTimers()
  })

  it('reports the pending transcript once while it stays unflushed', async () => {
    const pending = vi.fn()
    const snapshots: Snapshot[] = []
    const subscription = await subscribeCollecting(snapshots, pending)

    await vi.advanceTimersByTimeAsync(1_400)
    expect(pending).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    expect(pending).toHaveBeenCalledTimes(1)
    // Never a snapshot: an empty window sold as a settled read captures over
    // retained history and unblocks consumers that need a real transcript.
    expect(snapshots).toEqual([])

    // Latched: the still-failing poll must not re-report on every tick.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pending).toHaveBeenCalledTimes(1)

    subscription.unsubscribe()
  })

  it('leaves the settle to the real snapshot when the file lands inside the grace window', async () => {
    const unsubscribe = vi.fn()
    // Missing at subscribe time, flushed by the first poll tick.
    mocks.install.mockResolvedValueOnce(null).mockResolvedValue({ unsubscribe, watching: true })
    const pending = vi.fn()
    const subscription = await subscribeCollecting([], pending)

    await vi.advanceTimersByTimeAsync(5_000)
    // The engine owns the initial drain; an empty window announced here would
    // blank a real transcript for a frame.
    expect(pending).not.toHaveBeenCalled()

    subscription.unsubscribe()
  })

  it('does not report a subscription that was torn down first', async () => {
    const pending = vi.fn()
    const subscription = await subscribeCollecting([], pending)

    await vi.advanceTimersByTimeAsync(100)
    subscription.unsubscribe()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(pending).not.toHaveBeenCalled()
  })

  it('keeps the WSL gate message instead of overwriting it with the empty window', async () => {
    const stalled = new WslTranscriptFsError('timeout', 'WSL transcript files are unavailable.')
    mocks.install.mockRejectedValue(stalled)
    const pending = vi.fn()
    const snapshots: Snapshot[] = []
    const subscription = await subscribeCollecting(snapshots, pending)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(snapshots).toEqual([[[], false, 0, stalled.message]])
    expect(pending).not.toHaveBeenCalled()

    subscription.unsubscribe()
  })
})
