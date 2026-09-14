import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HostReadableTranscriptPathModule from './host-readable-transcript-path'
const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  observe: vi.fn(),
  observation: undefined as
    | ((runningDistros: readonly string[]) => Promise<void> | void)
    | undefined,
  resolve: vi.fn(),
  stopObservation: vi.fn(),
  toHostReadable: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))
vi.mock('./transcript-watch-engine', () => ({
  getActiveNativeChatWatcherCount: vi.fn(() => 0),
  installTranscriptWatcher: mocks.install
}))
vi.mock('./host-readable-transcript-path', async (importOriginal) => {
  const actual = await importOriginal<typeof HostReadableTranscriptPathModule>()
  return { ...actual, toHostReadableTranscriptPath: mocks.toHostReadable }
})
vi.mock('./wsl-transcript-running-observer', () => ({
  observeRunningWslDistros: mocks.observe
}))

import { subscribeNativeChatTranscript } from './transcript-watch'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('native chat transcript resolve polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.install.mockReset().mockReturnValue(null)
    mocks.resolve.mockReset().mockResolvedValue(null)
    mocks.observation = undefined
    mocks.stopObservation.mockReset()
    mocks.observe.mockReset().mockImplementation((callback) => {
      mocks.observation = callback
      return mocks.stopObservation
    })
    mocks.toHostReadable.mockReset().mockResolvedValue(null)
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

  it('retries WSL translation from shared observations, never installing the raw guest path', async () => {
    setPlatform('win32')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session-id',
      transcriptPath: '/home/ada/.codex/sessions/rollout-session-id.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await mocks.observation?.(['Ubuntu'])
    expect(mocks.toHostReadable).toHaveBeenCalledTimes(1)
    expect(mocks.install.mock.calls.some(([filePath]) => String(filePath).startsWith('/'))).toBe(
      false
    )

    await mocks.observation?.(['Ubuntu'])
    expect(mocks.toHostReadable).toHaveBeenCalledTimes(2)

    subscription.unsubscribe()
  })

  it('installs the translated UNC path once the WSL transcript becomes readable', async () => {
    setPlatform('win32')
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-session-id.jsonl'
    const engine = { unsubscribe: vi.fn(), watching: true }
    mocks.toHostReadable.mockResolvedValue(unc)
    mocks.install.mockResolvedValue(engine)

    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session-id',
      transcriptPath: '/home/ada/.codex/sessions/rollout-session-id.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await mocks.observation?.(['Ubuntu'])
    expect(mocks.install.mock.calls.some(([filePath]) => filePath === unc)).toBe(true)
    // The resolve observer hands ownership to the installed watcher.
    expect(mocks.toHostReadable).toHaveBeenCalledTimes(1)
    expect(mocks.stopObservation).toHaveBeenCalledOnce()

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

  it('degrades a gate-refused initial resolve to the poll fallback instead of failing', async () => {
    const engine = { unsubscribe: vi.fn(), watching: true }
    mocks.resolve
      .mockRejectedValueOnce(new WslTranscriptFsError('unavailable', 'stuck permits'))
      .mockResolvedValue('/home/ada/found.jsonl')
    mocks.install.mockImplementation((filePath: string) => (filePath ? engine : null))

    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session-id',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })
    expect(subscription.watching).toBe(true)

    await vi.advanceTimersByTimeAsync(20)
    expect(
      mocks.install.mock.calls.some(([filePath]) => filePath === '/home/ada/found.jsonl')
    ).toBe(true)
    subscription.unsubscribe()
    expect(engine.unsubscribe).toHaveBeenCalled()
  })

  it('still fails subscribe on non-gate resolver errors', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('resolver crashed'))

    await expect(
      subscribeNativeChatTranscript({
        agent: 'claude',
        sessionId: 'session-id',
        onAppend: () => {}
      })
    ).rejects.toThrow('resolver crashed')
  })

  it('cancels queued WSL resolution when the subscription closes', async () => {
    setPlatform('win32')
    let receivedSignal: AbortSignal | undefined
    mocks.toHostReadable.mockImplementation(
      (_path: string, deps: { signal?: AbortSignal }) =>
        new Promise<null>((_resolve, reject) => {
          receivedSignal = deps.signal
          deps.signal?.addEventListener('abort', () => reject(deps.signal?.reason), { once: true })
        })
    )
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'session-id',
      transcriptPath: '/home/ada/.codex/sessions/rollout-session-id.jsonl',
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    const observation = mocks.observation?.(['Ubuntu'])
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    expect(receivedSignal?.aborted).toBe(false)
    subscription.unsubscribe()
    expect(receivedSignal?.aborted).toBe(true)
    await observation
  })

  it('does not install after initial resolution is cancelled', async () => {
    let finishResolve: ((path: string) => void) | undefined
    mocks.resolve.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishResolve = resolve
        })
    )
    const controller = new AbortController()
    const cancelled = new Error('setup cancelled')
    const setup = subscribeNativeChatTranscript(
      {
        agent: 'codex',
        sessionId: 'session-id',
        onAppend: () => {}
      },
      controller.signal
    )

    controller.abort(cancelled)
    finishResolve?.('/transcript.jsonl')
    await expect(setup).rejects.toBe(cancelled)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('tears down a watcher returned after initial setup is cancelled', async () => {
    mocks.resolve.mockResolvedValue('/transcript.jsonl')
    const installControl: {
      finish?: (subscription: { unsubscribe: () => void; watching: boolean }) => void
    } = {}
    const unsubscribe = vi.fn()
    mocks.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          installControl.finish = resolve
        })
    )
    const controller = new AbortController()
    const cancelled = new Error('setup cancelled')
    const setup = subscribeNativeChatTranscript(
      {
        agent: 'codex',
        sessionId: 'session-id',
        onAppend: () => {}
      },
      controller.signal
    )
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())

    controller.abort(cancelled)
    installControl.finish?.({ unsubscribe, watching: true })
    await expect(setup).rejects.toBe(cancelled)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
