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
    // Pending must not masquerade as an empty snapshot and overwrite retained history.
    expect(snapshots).toEqual([])

    await vi.advanceTimersByTimeAsync(30_000)
    expect(pending).toHaveBeenCalledTimes(1)

    subscription.unsubscribe()
  })

  it('leaves the settle to the real snapshot when the file lands inside the grace window', async () => {
    const unsubscribe = vi.fn()
    mocks.install.mockResolvedValueOnce(null).mockResolvedValue({ unsubscribe, watching: true })
    const pending = vi.fn()
    const subscription = await subscribeCollecting([], pending)

    await vi.advanceTimersByTimeAsync(5_000)
    // The engine supplies the real snapshot; emitting empty here would flash away history.
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
