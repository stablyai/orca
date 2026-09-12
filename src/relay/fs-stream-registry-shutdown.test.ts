import type { FileHandle } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { RelayStreamRegistry } from './fs-stream-registry'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function handle(close: ReturnType<typeof vi.fn>): FileHandle {
  return { close } as unknown as FileHandle
}

describe('RelayStreamRegistry shutdown', () => {
  it('retains failed late pre-registration cleanup after the initial disposal snapshot', async () => {
    const registry = new RelayStreamRegistry()
    const finishMetadata = registry.beginOperation()
    const failure = new Error('late handle close failed')
    const close = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const result = registry.disposeAll().catch((error: unknown) => error)
    await flushTasks()
    const openedHandle = handle(close)
    expect(() => registry.register(openedHandle)).toThrow('relay_file_stream_shutdown_fenced')
    await expect(registry.releaseUnregisteredHandle(openedHandle)).rejects.toBe(failure)
    finishMetadata()
    expect(await result).toMatchObject({
      message: 'relay_file_stream_shutdown_incomplete',
      errors: [failure]
    })
    expect(registry.size()).toBe(1)
    await registry.disposeAll()
    expect(registry.size()).toBe(0)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('waits for a late pre-registration close owned by an admitted metadata operation', async () => {
    const registry = new RelayStreamRegistry()
    const finishMetadata = registry.beginOperation()
    const pending = deferred()
    const close = vi.fn(() => pending.promise)
    const finished = vi.fn()
    const drain = registry.disposeAll().then(finished)
    await flushTasks()
    const cleanup = registry.releaseUnregisteredHandle(handle(close)).finally(finishMetadata)
    await flushTasks()
    expect(finished).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([cleanup, drain])
    expect(registry.size()).toBe(0)
  })

  it('joins a release already waiting for the file handle to close', async () => {
    const registry = new RelayStreamRegistry()
    const pending = deferred()
    const close = vi.fn(() => pending.promise)
    const id = registry.register(handle(close))
    const release = registry.release(id)
    let disposed = false
    const dispose = registry.disposeAll().then(() => {
      disposed = true
    })

    try {
      await flushTasks()
      expect(disposed).toBe(false)
      expect(close).toHaveBeenCalledTimes(1)
      expect(registry.isAborted(id)).toBe(true)
    } finally {
      pending.resolve()
      await Promise.all([release, dispose])
    }
    expect(disposed).toBe(true)
    expect(registry.size()).toBe(0)
  })

  it('coalesces concurrent release calls until the single close settles', async () => {
    const registry = new RelayStreamRegistry()
    const pending = deferred()
    const close = vi.fn(() => pending.promise)
    const id = registry.register(handle(close))
    const first = registry.release(id)
    let secondSettled = false
    const second = registry.release(id).then(() => {
      secondSettled = true
    })

    try {
      await flushTasks()
      expect(close).toHaveBeenCalledTimes(1)
      expect(secondSettled).toBe(false)
    } finally {
      pending.resolve()
      await Promise.all([first, second])
    }
    expect(registry.size()).toBe(0)
  })

  it('retains a failed close for a later disposal retry', async () => {
    const registry = new RelayStreamRegistry()
    const failure = Object.assign(new Error('close failed'), { code: 'EIO' })
    const close = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const id = registry.register(handle(close))

    await expect(registry.release(id)).rejects.toBe(failure)
    expect(registry.size()).toBe(1)
    expect(registry.isAborted(id)).toBe(true)
    await registry.disposeAll()

    expect(close).toHaveBeenCalledTimes(2)
    expect(registry.size()).toBe(0)
  })

  it('waits for every close before rejecting disposal and retries only failed handles', async () => {
    const registry = new RelayStreamRegistry()
    const failure = Object.assign(new Error('close failed'), { code: 'EIO' })
    const failedClose = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const pending = deferred()
    const pendingClose = vi.fn(() => pending.promise)
    registry.register(handle(failedClose))
    registry.register(handle(pendingClose))
    let settled = false
    const result = registry.disposeAll().then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      }
    )

    try {
      await flushTasks()
      expect(settled).toBe(false)
      expect(failedClose).toHaveBeenCalledTimes(1)
      expect(pendingClose).toHaveBeenCalledTimes(1)
    } finally {
      pending.resolve()
    }
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([failure])
    expect(registry.size()).toBe(1)

    await registry.disposeAll()
    expect(failedClose).toHaveBeenCalledTimes(2)
    expect(pendingClose).toHaveBeenCalledTimes(1)
    expect(registry.size()).toBe(0)
  })

  it('tolerates EBADF as an already-closed handle', async () => {
    const registry = new RelayStreamRegistry()
    const close = vi.fn().mockRejectedValue(Object.assign(new Error('closed'), { code: 'EBADF' }))
    const id = registry.register(handle(close))

    await registry.release(id)
    await registry.disposeAll()

    expect(close).toHaveBeenCalledTimes(1)
    expect(registry.size()).toBe(0)
  })
})
