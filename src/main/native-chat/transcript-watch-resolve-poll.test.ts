import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  resolve: vi.fn(),
  resolveHostOwned: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve,
  resolveHostOwnedTranscriptPath: mocks.resolveHostOwned
}))
vi.mock('./transcript-watch-engine', () => ({
  getActiveNativeChatWatcherCount: vi.fn(() => 0),
  installTranscriptWatcher: mocks.install
}))
import { subscribeNativeChatTranscript } from './transcript-watch'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('native chat transcript resolve polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.install.mockReset().mockReturnValue(null)
    mocks.resolve.mockReset().mockResolvedValue(null)
    mocks.resolveHostOwned.mockReset().mockResolvedValue(null)
    // Why: a POSIX exact path is a WSL guest path on win32 and is deliberately
    // never installed raw there, so pin the platform instead of inheriting the
    // host's — otherwise these cases only hold on non-Windows machines.
    setPlatform('linux')
  })

  afterEach(() => {
    setPlatform(realPlatform)
    vi.useRealTimers()
  })

  it('fast-probes an exact hook path without repeatedly scanning the session tree', async () => {
    mocks.resolveHostOwned.mockResolvedValue('/verified/exact.jsonl')
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

  it('retries the WSL translation on the slow cadence, never installing the raw guest path', async () => {
    // Why: each translation sync-stats the UNC twin per distro over the 9P
    // share; doing it every fast tick would hammer the main process (#10326).
    setPlatform('win32')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session-id',
      transcriptPath: '/home/ada/.codex/sessions/rollout-session-id.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.resolveHostOwned).toHaveBeenCalledTimes(1)
    expect(mocks.install.mock.calls.some(([filePath]) => String(filePath).startsWith('/'))).toBe(
      false
    )

    await vi.advanceTimersByTimeAsync(5_100)
    expect(mocks.resolveHostOwned).toHaveBeenCalledTimes(2)

    subscription.unsubscribe()
  })

  it('does not install an unverified exact path after the initial resolver misses', async () => {
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session-id',
      transcriptPath: '/unrelated/existing.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(5_100)
    expect(mocks.install).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('installs the translated UNC path once the WSL transcript becomes readable', async () => {
    setPlatform('win32')
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-session-id.jsonl'
    mocks.resolveHostOwned.mockResolvedValue(unc)

    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session-id',
      transcriptPath: '/home/ada/.codex/sessions/rollout-session-id.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.install.mock.calls.some(([filePath]) => filePath === unc)).toBe(true)
    // Memoized: a successful translation is not re-probed on later ticks.
    expect(mocks.resolveHostOwned).toHaveBeenCalledTimes(1)

    subscription.unsubscribe()
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
