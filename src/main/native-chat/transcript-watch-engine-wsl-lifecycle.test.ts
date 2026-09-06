import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout.jsonl'
const EMPTY_STATS = { size: 0, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  dispose: vi.fn(),
  filterRunning: vi.fn(),
  invalidate: vi.fn(),
  observe: vi.fn(),
  observation: undefined as ((running: boolean) => Promise<void> | void) | undefined,
  rebindNeeded: true,
  stat: vi.fn()
}))

vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: mocks.filterRunning
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  stat: mocks.stat
}))
vi.mock('./transcript-native-watcher', () => ({
  createTranscriptNativeWatcher: () => ({
    bind: mocks.bind,
    dispose: mocks.dispose,
    invalidate: mocks.invalidate,
    needsRebind: () => mocks.rebindNeeded
  })
}))
vi.mock('./wsl-transcript-running-observer', () => ({
  observeWslTranscriptRunningState: mocks.observe
}))

import { installTranscriptWatcher } from './transcript-watch-engine'

describe('installed WSL transcript watcher lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.rebindNeeded = true
    mocks.bind.mockReset().mockImplementation(() => {
      mocks.rebindNeeded = false
      return true
    })
    mocks.dispose.mockReset()
    mocks.filterRunning.mockReset().mockResolvedValue([UNC_PATH])
    mocks.invalidate.mockReset().mockImplementation(() => {
      mocks.rebindNeeded = true
    })
    mocks.observation = undefined
    mocks.observe.mockReset().mockImplementation((_path, onRunning, onStopped) => {
      mocks.observation = (running) => (running ? onRunning() : onStopped())
      return vi.fn()
    })
    mocks.stat.mockReset().mockResolvedValue(EMPTY_STATS)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles the guarded initial drain when the distro stops after install', async () => {
    const onInitialSnapshot = vi.fn()
    const subscription = await installTranscriptWatcher(UNC_PATH, () => null, {
      agent: 'codex',
      sessionId: 'wsl-session',
      reconciliationIntervalMs: 100,
      onAppend: () => {},
      onInitialSnapshot
    })
    expect(subscription).not.toBeNull()

    mocks.filterRunning.mockResolvedValue([])
    const statsAfterInstall = mocks.stat.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)

    expect(mocks.stat).toHaveBeenCalledTimes(statsAfterInstall)
    expect(onInitialSnapshot).toHaveBeenCalledWith([], false, 0, 'Transcript unavailable')
    subscription?.unsubscribe()
  })

  it('does not settle after unsubscribe wins a delayed running probe', async () => {
    const onInitialSnapshot = vi.fn()
    const subscription = await installTranscriptWatcher(UNC_PATH, () => null, {
      agent: 'codex',
      sessionId: 'wsl-session',
      onAppend: () => {},
      onInitialSnapshot
    })
    let finishProbe: (() => void) | undefined
    mocks.filterRunning.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finishProbe = () => resolve([])
        })
    )

    const drain = vi.advanceTimersByTimeAsync(50)
    await vi.waitFor(() => expect(finishProbe).toBeDefined())
    subscription?.unsubscribe()
    finishProbe?.()
    await drain

    expect(onInitialSnapshot).not.toHaveBeenCalled()
  })

  it('suspends observation while stopped and resumes after an explicit start', async () => {
    const subscription = await installTranscriptWatcher(UNC_PATH, () => null, {
      agent: 'codex',
      sessionId: 'wsl-session',
      reconciliationIntervalMs: 100,
      onAppend: () => {}
    })
    await vi.advanceTimersByTimeAsync(50)
    const statsBeforeStop = mocks.stat.mock.calls.length

    mocks.observation?.(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.stat).toHaveBeenCalledTimes(statsBeforeStop)

    mocks.filterRunning.mockResolvedValue([UNC_PATH])
    mocks.observation?.(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.stat.mock.calls.length).toBeGreaterThan(statsBeforeStop)
    expect(mocks.bind).not.toHaveBeenCalled()
    subscription?.unsubscribe()
  })

  it('returns the running reconciliation promise to the shared observer', async () => {
    const subscription = await installTranscriptWatcher(UNC_PATH, () => null, {
      agent: 'codex',
      sessionId: 'wsl-session',
      onAppend: () => {}
    })
    await vi.advanceTimersByTimeAsync(50)
    let finishStat: (() => void) | undefined
    mocks.stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStat = () => resolve(EMPTY_STATS)
        })
    )

    const reconciliation = mocks.observation?.(true)
    expect(reconciliation).toBeInstanceOf(Promise)
    await vi.waitFor(() => expect(finishStat).toBeDefined())
    finishStat?.()
    await reconciliation
    subscription?.unsubscribe()
  })

  it('defers a failed observed UNC probe to the next shared observation', async () => {
    const subscription = await installTranscriptWatcher(UNC_PATH, () => null, {
      agent: 'codex',
      sessionId: 'wsl-session',
      onAppend: () => {}
    })
    await vi.advanceTimersByTimeAsync(50)
    mocks.filterRunning.mockClear().mockResolvedValue([])
    mocks.stat.mockClear().mockRejectedValueOnce(new Error('distro stopped'))

    await mocks.observation?.(true)

    expect(mocks.stat).toHaveBeenCalledTimes(1)
    expect(mocks.filterRunning).not.toHaveBeenCalled()
    await mocks.observation?.(false)
    expect(mocks.stat).toHaveBeenCalledTimes(1)
    subscription?.unsubscribe()
  })
})
