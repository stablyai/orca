import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, subscribeMock, writeFileSyncMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  subscribeMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('node:fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-canary-test'),
  rmSync: vi.fn(),
  writeFileSync: writeFileSyncMock
}))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('@parcel/watcher', () => ({ subscribe: subscribeMock }))

describe('parcel watcher process canary', () => {
  let originalMessageListeners: ReturnType<typeof process.listeners>
  let originalExitListeners: ReturnType<typeof process.listeners>
  let originalDisconnectListeners: ReturnType<typeof process.listeners>
  let originalSend: typeof process.send

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    subscribeMock.mockReset()
    statMock.mockReset()
    writeFileSyncMock.mockReset()
    originalMessageListeners = process.listeners('message')
    originalExitListeners = process.listeners('exit')
    originalDisconnectListeners = process.listeners('disconnect')
    originalSend = process.send
  })

  afterEach(() => {
    for (const listener of process.listeners('message')) {
      if (!originalMessageListeners.includes(listener)) {
        process.off('message', listener)
      }
    }
    for (const listener of process.listeners('exit')) {
      if (!originalExitListeners.includes(listener)) {
        process.off('exit', listener)
      }
    }
    for (const listener of process.listeners('disconnect')) {
      if (!originalDisconnectListeners.includes(listener)) {
        process.off('disconnect', listener)
      }
    }
    process.send = originalSend
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not restart while a native subscription is still crawling', async () => {
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockReturnValueOnce(new Promise(() => undefined))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/large-repo', opts: {} })

    await vi.advanceTimersByTimeAsync(30_000)

    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('invalidates an outstanding probe when another subscription starts crawling', async () => {
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockReturnValueOnce(new Promise(() => undefined))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)

    process.emit('message', { op: 'subscribe', id: 2, dir: '/large-repo', opts: {} })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('still restarts when unsubscribe deadlocks while another root remains live', async () => {
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: vi.fn(() => new Promise(() => undefined)) })
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo-a', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 2, dir: '/repo-b', opts: {} })
    await vi.advanceTimersByTimeAsync(0)

    process.emit('message', { op: 'unsubscribe', id: 1 })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(writeFileSyncMock).toHaveBeenCalledTimes(3)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('drains active crawls before starting teardown deadlock detection', async () => {
    let finishSecondCrawl:
      | ((subscription: { unsubscribe: () => Promise<void> }) => void)
      | undefined
    const deadlockedUnsubscribe = vi.fn(() => new Promise<void>(() => undefined))
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: deadlockedUnsubscribe })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishSecondCrawl = resolve
        })
      )
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo-a', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 2, dir: '/repo-b', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'unsubscribe', id: 1 })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(deadlockedUnsubscribe).not.toHaveBeenCalled()
    expect(writeFileSyncMock).not.toHaveBeenCalled()

    finishSecondCrawl?.({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(deadlockedUnsubscribe).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('keeps later crawls queued behind teardown deadlock detection', async () => {
    const deadlockedUnsubscribe = vi.fn(() => new Promise<void>(() => undefined))
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: deadlockedUnsubscribe })
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo-a', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 2, dir: '/repo-b', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'unsubscribe', id: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(deadlockedUnsubscribe).toHaveBeenCalledTimes(1)

    process.emit('message', { op: 'subscribe', id: 3, dir: '/repo-c', opts: {} })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(subscribeMock).toHaveBeenCalledTimes(3)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('reserves teardown order while its subscription is still crawling', async () => {
    let finishCrawl: ((subscription: { unsubscribe: () => Promise<void> }) => void) | undefined
    const deadlockedUnsubscribe = vi.fn(() => new Promise<void>(() => undefined))
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishCrawl = resolve
        })
      )
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/live-repo', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 2, dir: '/crawling-repo', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'unsubscribe', id: 2 })
    process.emit('message', { op: 'subscribe', id: 3, dir: '/later-repo', opts: {} })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(writeFileSyncMock).not.toHaveBeenCalled()

    finishCrawl?.({ unsubscribe: deadlockedUnsubscribe })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(deadlockedUnsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribeMock).toHaveBeenCalledTimes(3)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('removes a cancelled queued crawl before it reaches Parcel', async () => {
    let finishActiveCrawl:
      | ((subscription: { unsubscribe: () => Promise<void> }) => void)
      | undefined
    subscribeMock.mockResolvedValueOnce({ unsubscribe: vi.fn() }).mockReturnValueOnce(
      new Promise((resolve) => {
        finishActiveCrawl = resolve
      })
    )
    const sendMock = vi.fn()
    process.send = sendMock

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/active', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 2, dir: '/queued', opts: {} })
    process.emit('message', { op: 'cancel-subscribe', id: 2 })

    // Why: non-restart cancel reuses async unsubscribe teardown; drain the
    // exclusive lifecycle queue after the active crawl finishes.
    finishActiveCrawl?.({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith({ op: 'unsubscribed', id: 2 })
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(sendMock).not.toHaveBeenCalledWith({ op: 'subscribe-started', id: 2 })
    expect(sendMock).not.toHaveBeenCalledWith({ op: 'subscribed', id: 2 })
  })

  it('unsubscribes a late cancel after the crawl already finished', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    subscribeMock.mockResolvedValueOnce({ unsubscribe: vi.fn() }).mockResolvedValueOnce({
      unsubscribe
    })
    const sendMock = vi.fn()
    process.send = sendMock

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/finished', opts: {} })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith({ op: 'subscribed', id: 1 })
    process.emit('message', { op: 'cancel-subscribe', id: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith({ op: 'unsubscribed', id: 1 })
    expect(sendMock).not.toHaveBeenCalledWith({ op: 'cancel-requires-restart', id: 1 })
  })

  it('asks the host to restart when an active crawl is cancelled', async () => {
    let finishCrawl: ((subscription: { unsubscribe: () => Promise<void> }) => void) | undefined
    subscribeMock.mockResolvedValueOnce({ unsubscribe: vi.fn() }).mockReturnValueOnce(
      new Promise((resolve) => {
        finishCrawl = resolve
      })
    )
    const sendMock = vi.fn()
    process.send = sendMock

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/active', opts: {} })
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'cancel-subscribe', id: 1 })

    expect(sendMock).toHaveBeenCalledWith({ op: 'cancel-requires-restart', id: 1 })
    finishCrawl?.({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    await vi.advanceTimersByTimeAsync(0)
    expect(sendMock).not.toHaveBeenCalledWith({ op: 'subscribed', id: 1 })
  })

  it('still restarts after consecutive missed events once every subscription is live', async () => {
    subscribeMock.mockResolvedValue({ unsubscribe: vi.fn() })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo', opts: {} })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(writeFileSyncMock).toHaveBeenCalledTimes(3)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  it('collapses and enriches runtime batches before they cross child IPC', async () => {
    let callback:
      | ((err: Error | null, events: { type: string; path: string }[]) => void)
      | undefined
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockImplementationOnce(async (_dir, nextCallback) => {
        callback = nextCallback
        return { unsubscribe: vi.fn() }
      })
    statMock.mockImplementation(async (eventPath: string) => ({
      isDirectory: () => eventPath.endsWith('/dir')
    }))
    const sendMock = vi.fn()
    process.send = sendMock

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', {
      op: 'subscribe',
      id: 1,
      dir: '/repo',
      opts: {},
      delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 2 }
    })
    await vi.advanceTimersByTimeAsync(0)

    callback?.(null, [
      { type: 'update', path: '/repo/file.txt' },
      { type: 'create', path: '/repo/dir' }
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(sendMock).toHaveBeenCalledWith(
      {
        op: 'events',
        id: 1,
        events: [
          { type: 'update', path: '/repo/file.txt', isDirectory: false },
          { type: 'create', path: '/repo/dir', isDirectory: true }
        ]
      },
      expect.any(Function)
    )

    sendMock.mockClear()
    callback?.(null, [
      { type: 'update', path: '/repo/a' },
      { type: 'update', path: '/repo/b' },
      { type: 'update', path: '/repo/c' }
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(sendMock).toHaveBeenCalledWith({ op: 'overflow', id: 1 }, expect.any(Function))
    expect(statMock).toHaveBeenCalledTimes(2)
  })

  it('reports an FSEvents overflow and keeps delivering later events', async () => {
    let callback:
      | ((err: Error | null, events: { type: string; path: string }[]) => void)
      | undefined
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockImplementationOnce(async (_dir, nextCallback) => {
        callback = nextCallback
        return { unsubscribe: vi.fn() }
      })
    const sendMock = vi.fn()
    process.send = sendMock

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'subscribe', id: 1, dir: '/repo', opts: {} })
    await vi.advanceTimersByTimeAsync(0)

    callback?.(
      new Error('Events were dropped by the FSEvents client. File system must be re-scanned.'),
      []
    )
    callback?.(null, [{ type: 'update', path: '/repo/after-overflow.txt' }])
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith({
      op: 'watch-error',
      id: 1,
      message: 'Events were dropped by the FSEvents client. File system must be re-scanned.'
    })
    expect(sendMock).toHaveBeenCalledWith(
      {
        op: 'events',
        id: 1,
        events: [{ type: 'update', path: '/repo/after-overflow.txt' }]
      },
      expect.any(Function)
    )
  })

  it('bounds pending event batches while child IPC reports backpressure', async () => {
    let callback:
      | ((err: Error | null, events: { type: string; path: string }[]) => void)
      | undefined
    let releaseFirstEvent: (() => void) | undefined
    const sentEventPaths: string[] = []
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockImplementationOnce(async (_dir, nextCallback) => {
        callback = nextCallback
        return { unsubscribe: vi.fn() }
      })
    process.send = vi.fn((message, onSent) => {
      if (message.op !== 'events') {
        return true
      }
      sentEventPaths.push(message.events[0]?.path ?? '')
      if (!releaseFirstEvent) {
        releaseFirstEvent = onSent
        return false
      }
      return true
    }) as typeof process.send

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', {
      op: 'subscribe',
      id: 1,
      dir: '/repo',
      opts: {},
      delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 2 }
    })
    await vi.advanceTimersByTimeAsync(0)

    callback?.(null, [{ type: 'update', path: '/repo/first.txt' }])
    callback?.(null, [{ type: 'update', path: '/repo/second.txt' }])
    callback?.(null, [{ type: 'update', path: '/repo/third.txt' }])
    callback?.(null, [{ type: 'update', path: '/repo/fourth.txt' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(sentEventPaths).toEqual(['/repo/first.txt'])

    releaseFirstEvent?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(sentEventPaths).toEqual(['/repo/first.txt'])
    expect(process.send).toHaveBeenCalledWith({ op: 'overflow', id: 1 }, expect.any(Function))
    expect(statMock).toHaveBeenCalledTimes(1)
  })

  it('drops queued event work when the subscription is removed', async () => {
    let callback:
      | ((err: Error | null, events: { type: string; path: string }[]) => void)
      | undefined
    let releaseFirstEvent: (() => void) | undefined
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    subscribeMock
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockImplementationOnce(async (_dir, nextCallback) => {
        callback = nextCallback
        return { unsubscribe }
      })
    process.send = vi.fn((message, onSent) => {
      if (message.op === 'events' && !releaseFirstEvent) {
        releaseFirstEvent = onSent
        return false
      }
      return true
    }) as typeof process.send

    await import('./parcel-watcher-process-entry')
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', {
      op: 'subscribe',
      id: 1,
      dir: '/repo',
      opts: {},
      delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 2 }
    })
    await vi.advanceTimersByTimeAsync(0)

    callback?.(null, [{ type: 'update', path: '/repo/first.txt' }])
    callback?.(null, [{ type: 'update', path: '/repo/queued.txt' }])
    await vi.advanceTimersByTimeAsync(0)
    process.emit('message', { op: 'unsubscribe', id: 1 })
    await vi.advanceTimersByTimeAsync(0)
    releaseFirstEvent?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(process.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'events',
        events: [expect.objectContaining({ path: '/repo/queued.txt' })]
      }),
      expect.any(Function)
    )
  })
})
