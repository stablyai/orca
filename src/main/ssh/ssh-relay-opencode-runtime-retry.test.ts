import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteOpenCodeRuntimeRetry } from './ssh-relay-opencode-runtime-retry'

afterEach(() => vi.useRealTimers())

describe('scan-triggered SSH OpenCode runtime preparation', () => {
  it('rechecks an empty host after the cooldown, coalesces scans, and stops once ready', async () => {
    vi.useFakeTimers()
    const retry = vi.fn().mockResolvedValue('ready')
    const prepare = createRemoteOpenCodeRuntimeRetry(
      Promise.resolve('not-needed'),
      Promise.resolve(true),
      retry
    )
    const signal = new AbortController().signal
    await prepare(signal)
    expect(retry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all([prepare(signal), prepare(signal), prepare(signal)])
    expect(retry).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    await prepare(signal)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('waits for initial background cleanup before a scan can retry', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const cleanup = new Promise<boolean>((resolve) => {
      finish = () => resolve(true)
    })
    const retry = vi.fn().mockResolvedValue('ready')
    const prepare = createRemoteOpenCodeRuntimeRetry(Promise.resolve('failed'), cleanup, retry)
    await prepare(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(30_000)
    const pending = prepare(new AbortController().signal)
    await Promise.resolve()
    expect(retry).not.toHaveBeenCalled()
    finish()
    await pending
    expect(retry).toHaveBeenCalledOnce()
  })

  it('cancels a queued retry on session teardown without starting a remote command', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const prepare = createRemoteOpenCodeRuntimeRetry(
      Promise.resolve('not-needed'),
      new Promise(() => {}),
      retry
    )
    const controller = new AbortController()
    await prepare(controller.signal)
    await vi.advanceTimersByTimeAsync(60_000)
    const pending = prepare(controller.signal)
    controller.abort()
    await pending
    await prepare(controller.signal)
    expect(retry).not.toHaveBeenCalled()
  })

  it('never retries an unconfirmed remote teardown', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const prepare = createRemoteOpenCodeRuntimeRetry(
      Promise.resolve('teardown-unconfirmed'),
      Promise.resolve(true),
      retry
    )
    await vi.advanceTimersByTimeAsync(3600_000)
    await prepare(new AbortController().signal)
    expect(retry).not.toHaveBeenCalled()
  })

  it('never retries after deployment cleanup reports an unconfirmed command', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const prepare = createRemoteOpenCodeRuntimeRetry(
      Promise.resolve('not-needed'),
      Promise.resolve(false),
      retry
    )
    await prepare(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(60_000)
    await prepare(new AbortController().signal)
    await vi.advanceTimersByTimeAsync(3600_000)
    await prepare(new AbortController().signal)
    expect(retry).not.toHaveBeenCalled()
  })
})
