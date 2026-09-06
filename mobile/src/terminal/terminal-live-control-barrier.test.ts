import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

afterEach(() => vi.useRealTimers())
describe('bounded terminal control barriers', () => {
  it('serializes 64 held controls at a 500ms receipt cost without merging execution boundaries', async () => {
    vi.useFakeTimers()
    const state = createTerminalLivePendingFlushState()
    const started: number[] = []
    const start = Date.now()
    const sender = () => {
      started.push(Date.now() - start)
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500))
    }
    const controls = Array.from({ length: 64 }, () =>
      queueTerminalLiveMirrorSend(state, 't', '\x7f', sender, { barrier: true })
    )
    expect(state.requestCount).toBe(64)
    expect(started).toEqual([0])
    await vi.advanceTimersByTimeAsync(32000)
    expect(await Promise.all(controls)).toEqual(Array(64).fill(true))
    expect(started).toHaveLength(64)
    expect(started.at(-1)).toBe(31500)
    expect(state.retainedBytes).toBe(0)
    expect(state.requestCount).toBe(0)
  })
  it('fails closed at the 65th control instead of retaining or dispatching an unbounded repeat burst', async () => {
    let finish!: (sent: boolean) => void
    const sender = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const state = createTerminalLivePendingFlushState()
    const controls = Array.from({ length: 65 }, () =>
      queueTerminalLiveMirrorSend(state, 't', '\x1b[A', sender, { barrier: true })
    )
    expect(await controls[64]).toBe(false)
    expect(state.requestCount).toBe(1)
    expect(state.pendingBatches).toHaveLength(0)
    finish(true)
    expect(await Promise.all(controls)).toEqual([true, ...Array(64).fill(false)])
    expect(sender).toHaveBeenCalledOnce()
    expect(await waitForTerminalLivePendingFlush(state)).toBe(false)
    expect(state.requestCount).toBe(0)
    expect(state.retainedBytes).toBe(0)
  })
})
