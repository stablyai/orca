import { describe, expect, it, vi } from 'vitest'
import { CdpCommandQueue } from './cdp-command-queue'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('CdpCommandQueue', () => {
  it('preserves ordinary per-tab command order', async () => {
    const first = deferred()
    const calls: number[] = []
    const queue = new CdpCommandQueue(() => new Error('full'), 4, 8)
    const one = queue.enqueue('tab-1', async () => {
      calls.push(1)
      await first.promise
      return 'one'
    })
    const two = queue.enqueue('tab-1', async () => {
      calls.push(2)
      return 'two'
    })

    expect(calls).toEqual([1])
    first.resolve()

    await expect(Promise.all([one, two])).resolves.toEqual(['one', 'two'])
    expect(calls).toEqual([1, 2])
  })

  it('rejects commands beyond per-tab and aggregate queue caps', async () => {
    const first = deferred()
    const second = deferred()
    const queue = new CdpCommandQueue(() => new Error('full'), 2, 3)
    const active = queue.enqueue('tab-1', () => first.promise)
    const activeTwo = queue.enqueue('tab-2', () => second.promise)
    const queued = [
      queue.enqueue('tab-1', async () => 1),
      queue.enqueue('tab-1', async () => 2),
      queue.enqueue('tab-2', async () => 3)
    ]

    await expect(queue.enqueue('tab-1', async () => 4)).rejects.toThrow('full')
    await expect(queue.enqueue('tab-3', async () => 5)).rejects.toThrow('full')

    first.resolve()
    second.resolve()
    await expect(Promise.all([active, activeTwo, ...queued])).resolves.toEqual([
      undefined,
      undefined,
      1,
      2,
      3
    ])
  })

  it('rejects retained commands when a tab closes and continues a replacement queue', async () => {
    const first = deferred()
    const executeAfterClose = vi.fn(async () => 'stale')
    const queue = new CdpCommandQueue(() => new Error('full'), 4, 8)
    const active = queue.enqueue('tab-1', () => first.promise)
    const stale = queue.enqueue('tab-1', executeAfterClose)

    queue.closeTab('tab-1', new Error('closed'))
    await expect(stale).rejects.toThrow('closed')
    expect(executeAfterClose).not.toHaveBeenCalled()

    const replacement = queue.enqueue('tab-1', async () => 'fresh')
    first.resolve()
    await expect(active).resolves.toBeUndefined()
    await expect(replacement).resolves.toBe('fresh')
  })
})
