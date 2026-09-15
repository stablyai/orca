import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { watchMock, statMock, statSyncMock } = vi.hoisted(() => ({
  watchMock: vi.fn(),
  statMock: vi.fn(),
  statSyncMock: vi.fn()
}))
vi.mock('node:fs', () => ({ watch: watchMock, statSync: statSyncMock }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
import { startShallowWatcher } from './parcel-watcher-shallow-subscription'

class Watcher extends EventEmitter {
  close = vi.fn(() => {
    this.emit('close')
  })
  constructor(readonly change: (event: string, name: string) => void) {
    super()
  }
}
const root = join('folder', 'metadata')
const identity = (ino = 1) => ({ dev: 1, ino, isDirectory: () => true })
let created: Watcher[]
const subscribe = (onError = vi.fn(), onEvents = vi.fn()) =>
  startShallowWatcher(root, ['HEAD', 'logs/HEAD'], onEvents, onError)

beforeEach(() => {
  vi.useFakeTimers()
  created = []
  statMock.mockReset().mockResolvedValue(identity())
  statSyncMock.mockReset().mockReturnValue(identity())
  watchMock.mockReset().mockImplementation((_path, _options, change) => {
    const watcher = new Watcher(change)
    created.push(watcher)
    return watcher
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('shallow watcher binding ownership', () => {
  it('reuses unsubscribe completion during and after delayed normal close', async () => {
    const subscription = subscribe()
    created[0].close.mockImplementation(() => {})
    const first = subscription.unsubscribe()
    const settled = vi.fn()
    void first.then(settled)
    expect(subscription.unsubscribe()).toBe(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    created[0].emit('close')
    await first
    expect(subscription.unsubscribe()).toBe(first)
    await subscription.unsubscribe()
    expect(created[0].close).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it.each(['close', 'error'] as const)(
    'remembers prior terminal %s without awaiting another close',
    async (event) => {
      const onError = vi.fn()
      const subscription = subscribe(onError)
      created[0].close.mockImplementation(() => {})
      created[0].emit(event, new Error('native terminal'))
      await subscription.unsubscribe()
      await subscription.unsubscribe()
      expect(created[0].close).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledTimes(event === 'error' ? 1 : 0)
    }
  )

  it('settles an in-flight close on terminal error without a close event', async () => {
    const subscription = subscribe()
    created[0].close.mockImplementation(() => {})
    const completion = subscription.unsubscribe()
    created[0].emit('error', new Error('native terminal'))
    await completion
    created[0].emit('close')
    expect(subscription.unsubscribe()).toBe(completion)
  })

  it('rejects throwing close without terminal evidence and reuses that failure', async () => {
    const subscription = subscribe()
    const failure = new Error('still live')
    created[0].close.mockImplementation(() => {
      throw failure
    })
    const completion = subscription.unsubscribe()
    await expect(completion).rejects.toBe(failure)
    expect(subscription.unsubscribe()).toBe(completion)
    await expect(subscription.unsubscribe()).rejects.toBe(failure)
    expect(created[0].close).toHaveBeenCalledTimes(1)
    expect(created[1].close).toHaveBeenCalledTimes(1)
    created[0].emit('close')
  })

  it.each(['close', 'error'] as const)(
    'accepts terminal %s established before close throws',
    async (event) => {
      const subscription = subscribe()
      created[0].close.mockImplementation(() => {
        created[0].emit(event, new Error('terminal'))
        throw new Error('after terminal')
      })
      await subscription.unsubscribe()
    }
  )

  it.each(['close', 'error'] as const)(
    'isolates late old %s and updates from replacement identity',
    async (event) => {
      const onEvents = vi.fn()
      const subscription = subscribe(vi.fn(), onEvents)
      const old = created[1]
      old.close.mockImplementation(() => {})
      created[0].change('rename', 'logs')
      const replacement = created[2]
      old.emit(event, new Error('old terminal'))
      onEvents.mockClear()
      old.change('change', 'HEAD')
      expect(onEvents).not.toHaveBeenCalled()
      replacement.change('change', 'HEAD')
      expect(onEvents).toHaveBeenCalledWith([{ type: 'update', path: join(root, 'logs', 'HEAD') }])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(created).toHaveLength(3)
      await subscription.unsubscribe()
      expect(replacement.close).toHaveBeenCalledTimes(1)
    }
  )

  it('awaits the retired generation as well as its replacement', async () => {
    const subscription = subscribe()
    const old = created[1]
    old.close.mockImplementation(() => {})
    created[0].change('rename', 'logs')
    const settled = vi.fn()
    const completion = subscription.unsubscribe()
    void completion.then(settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    expect(created[2].close).toHaveBeenCalledTimes(1)
    old.emit('close')
    await completion
    expect(old.close).toHaveBeenCalledTimes(1)
  })

  it('preserves failed retired teardown for unsubscribe and host recovery', async () => {
    const onError = vi.fn()
    const subscription = subscribe(onError)
    const failure = new Error('retired handle still live')
    created[1].close.mockImplementation(() => {
      throw failure
    })
    created[0].change('rename', 'logs')
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(failure)
    await expect(subscription.unsubscribe()).rejects.toBe(failure)
    expect(created[2].close).toHaveBeenCalledTimes(1)
    created[1].emit('close')
  })

  it('rebinds after terminal error even when the directory inode is unchanged', async () => {
    const subscription = subscribe()
    created[1].emit('error', new Error('terminal'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(created).toHaveLength(3)
    await subscription.unsubscribe()
    expect(created[2].close).toHaveBeenCalledTimes(1)
  })

  it('retries failed binding creation instead of recording an unwatched identity', async () => {
    const subscription = subscribe()
    statMock.mockResolvedValue(identity(2))
    statSyncMock.mockReturnValue(identity(2))
    watchMock.mockImplementationOnce(() => {
      throw new Error('missing')
    })
    await vi.advanceTimersByTimeAsync(30_000)
    const attempts = watchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(watchMock).toHaveBeenCalledTimes(attempts + 1)
    await subscription.unsubscribe()
  })

  it('does not let an old async identity probe rebind a replacement', async () => {
    const subscription = subscribe()
    const pending = Promise.withResolvers<ReturnType<typeof identity>>()
    statMock.mockImplementation((path) =>
      path === join(root, 'logs') ? pending.promise : Promise.resolve(identity())
    )
    await vi.advanceTimersByTimeAsync(30_000)
    created[0].change('rename', 'logs')
    pending.resolve(identity(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(created).toHaveLength(3)
    await subscription.unsubscribe()
  })
})
