import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listRunning: vi.fn() }))

vi.mock('../wsl', () => ({ listRunningWslDistrosAsync: mocks.listRunning }))

import {
  observeWslTranscriptRunningState,
  resetWslTranscriptRunningObserverForTests
} from './wsl-transcript-running-observer'

describe('WSL transcript running observer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listRunning.mockReset().mockResolvedValue(['Ubuntu'])
  })

  afterEach(() => {
    resetWslTranscriptRunningObserverForTests()
    vi.useRealTimers()
  })

  it('shares one running-distro probe across staggered watchers', async () => {
    const ubuntu = vi.fn()
    const debian = vi.fn()
    const stopUbuntu = observeWslTranscriptRunningState(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\a.jsonl',
      () => ubuntu(true),
      () => ubuntu(false)
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const stopDebian = observeWslTranscriptRunningState(
      '\\\\wsl.localhost\\Debian\\home\\ada\\b.jsonl',
      () => debian(true),
      () => debian(false)
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.listRunning).toHaveBeenCalledTimes(1)
    expect(ubuntu).toHaveBeenCalledWith(true)
    expect(debian).toHaveBeenCalledWith(false)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.listRunning).toHaveBeenCalledTimes(2)
    stopUbuntu()
    stopDebian()
  })

  it('coalesces slow subscription callbacks and retains the latest observation', async () => {
    let finishFirst: (() => void) | undefined
    const callback = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    const stop = observeWslTranscriptRunningState(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\a.jsonl',
      callback,
      callback
    )

    await vi.advanceTimersByTimeAsync(2_000)
    expect(callback).toHaveBeenCalledTimes(1)

    mocks.listRunning.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(6_000)
    expect(mocks.listRunning).toHaveBeenCalledTimes(4)
    expect(callback).toHaveBeenCalledTimes(1)

    finishFirst?.()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    stop()
  })
})
