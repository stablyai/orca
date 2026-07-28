import { describe, expect, it, vi } from 'vitest'
import { createTerminalInputQueue, type TerminalInputQueueSend } from './terminal-input-queue'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('terminal input queue', () => {
  it('keeps one operation in flight and advances only after its matching acknowledgement', async () => {
    const first = deferred<'accepted' | 'rejected'>()
    const send = vi
      .fn<TerminalInputQueueSend>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('accepted')
    const queue = createTerminalInputQueue({
      queueId: 'queue-1',
      send,
      getConnectionState: () => 'connected',
      onConnectionStateChange: () => () => {}
    })

    const firstResult = queue.enqueue('terminal-1', 'a')
    const secondResult = queue.enqueue('terminal-1', 'b')
    await Promise.resolve()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenNthCalledWith(1, {
      queueId: 'queue-1',
      sequence: 1,
      terminal: 'terminal-1',
      text: 'a'
    })

    first.resolve('accepted')
    await expect(firstResult).resolves.toBe(true)
    await expect(secondResult).resolves.toBe(true)
    expect(send).toHaveBeenNthCalledWith(2, {
      queueId: 'queue-1',
      sequence: 2,
      terminal: 'terminal-1',
      text: 'b'
    })
  })

  it('retries an ambiguous failure with the same queue identity and sequence', async () => {
    let retry: (() => void) | null = null
    const send = vi
      .fn<TerminalInputQueueSend>()
      .mockRejectedValueOnce(new Error('Connection interrupted'))
      .mockResolvedValueOnce('accepted')
    const queue = createTerminalInputQueue({
      queueId: 'queue-1',
      send,
      getConnectionState: () => 'connected',
      onConnectionStateChange: () => () => {},
      scheduleRetry: (run) => {
        retry = run
        return () => {
          retry = null
        }
      }
    })

    const result = queue.enqueue('terminal-1', 'さ')
    await vi.waitFor(() => expect(retry).not.toBeNull())
    retry?.()

    await expect(result).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  })

  it('waits for reconnection before retrying a failed operation', async () => {
    let connectionState: 'connected' | 'reconnecting' = 'connected'
    let stateListener: ((state: 'connected' | 'reconnecting') => void) | null = null
    const send = vi.fn<TerminalInputQueueSend>().mockImplementationOnce(async () => {
      connectionState = 'reconnecting'
      throw new Error('Connection interrupted')
    })
    send.mockResolvedValueOnce('accepted')
    const queue = createTerminalInputQueue({
      queueId: 'queue-1',
      send,
      getConnectionState: () => connectionState,
      onConnectionStateChange: (listener) => {
        stateListener = listener
        return () => {
          stateListener = null
        }
      }
    })

    const result = queue.enqueue('terminal-1', '한')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)

    connectionState = 'connected'
    stateListener?.('connected')

    await expect(result).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('drops dependent queued input after a definitive rejection without creating a sequence gap', async () => {
    const first = deferred<'accepted' | 'rejected'>()
    const send = vi
      .fn<TerminalInputQueueSend>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('accepted')
    const queue = createTerminalInputQueue({
      queueId: 'queue-1',
      send,
      getConnectionState: () => 'connected',
      onConnectionStateChange: () => () => {}
    })

    const rejected = queue.enqueue('terminal-1', 'a')
    const dependent = queue.enqueue('terminal-1', 'b')
    first.resolve('rejected')

    await expect(rejected).resolves.toBe(false)
    await expect(dependent).resolves.toBe(false)
    expect(send).toHaveBeenCalledOnce()

    await expect(queue.enqueue('terminal-1', 'c')).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(2, {
      queueId: 'queue-1',
      sequence: 2,
      terminal: 'terminal-1',
      text: 'c'
    })
  })

  it('settles queued operations as rejected when closed', async () => {
    const pending = deferred<'accepted' | 'rejected'>()
    const queue = createTerminalInputQueue({
      queueId: 'queue-1',
      send: () => pending.promise,
      getConnectionState: () => 'connected',
      onConnectionStateChange: () => () => {}
    })

    const result = queue.enqueue('terminal-1', 'a')
    queue.close()

    await expect(result).resolves.toBe(false)
  })
})
