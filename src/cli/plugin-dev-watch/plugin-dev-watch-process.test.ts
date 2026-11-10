import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onPluginDevWatchInterrupt, waitUnlessAborted } from './plugin-dev-watch-process'

function fakeProcess(platform: NodeJS.Platform) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { platform })
}

afterEach(() => vi.useRealTimers())

describe('onPluginDevWatchInterrupt', () => {
  it('listens for Ctrl-C and Ctrl-Break on Windows, and unsubscribes', () => {
    const target = fakeProcess('win32')
    const listener = vi.fn()
    const unsubscribe = onPluginDevWatchInterrupt(listener, target)
    target.emit('SIGINT')
    target.emit('SIGBREAK')
    target.emit('SIGTERM')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    target.emit('SIGINT')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('also stops on SIGTERM and SIGHUP on POSIX', () => {
    const target = fakeProcess('linux')
    const listener = vi.fn()
    onPluginDevWatchInterrupt(listener, target)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      target.emit(signal)
    }
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('waitUnlessAborted', () => {
  it('resolves after the delay, or at once when aborted', async () => {
    vi.useFakeTimers()
    const stop = new AbortController()
    let done = false
    void waitUnlessAborted(500, stop.signal).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    stop.abort()
    await Promise.resolve()
    expect(done).toBe(true)
    await expect(waitUnlessAborted(500, stop.signal)).resolves.toBeUndefined()
  })
})
