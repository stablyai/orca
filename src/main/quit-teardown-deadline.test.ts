import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  settleTeardownWithinDeadline,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from './quit-teardown-deadline'

describe('settleTeardownWithinDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves as soon as all teardowns settle, including rejections', async () => {
    vi.useFakeTimers()
    let resolved = false
    const pending = settleTeardownWithinDeadline([
      { name: 'daemon', promise: Promise.resolve() },
      { name: 'runtime-rpc', promise: Promise.reject(new Error('daemon disconnect failed')) }
    ]).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(resolved).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the teardowns still pending at the deadline', async () => {
    vi.useFakeTimers()
    const pending = settleTeardownWithinDeadline([
      { name: 'daemon', promise: Promise.resolve() },
      { name: 'runtime-rpc', promise: new Promise(() => {}) }
    ])
    await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS - 1)
    let resolved = false
    void pending.then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual(['runtime-rpc'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
