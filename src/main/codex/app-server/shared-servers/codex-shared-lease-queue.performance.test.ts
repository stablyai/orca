import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSharedLeaseQueue } from './codex-shared-lease-queue'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shared Codex lease queue', () => {
  it('drains a long backlog moving each held slot a bounded number of times', () => {
    let reading = false
    const queue = new CodexSharedLeaseQueue({
      canDispatch: () => reading,
      dispatch: () => {},
      backlog: () => {},
      refuse: () => {}
    })
    const frames = 20_000
    const text = 'x'.repeat(1_000)
    for (let index = 0; index < frames; index += 1) {
      queue.push({ kind: 'notification', method: 'item/delta', params: { threadId: 't', text } })
    }
    // Slots a splice shifts down: the array's tail behind what it removes.
    let shifted = 0
    const splice = Array.prototype.splice
    vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
      this: unknown[],
      ...args: [number, number]
    ) {
      shifted += Math.max(0, this.length - args[0] - args[1])
      return splice.apply(this, args)
    })
    reading = true
    while (queue.pending > 0) {
      queue.drain()
    }
    // One splice per 64 KiB batch would shift about 3 million slots here.
    expect(shifted).toBeLessThanOrEqual(2 * frames)
  })
})
