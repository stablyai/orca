import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ORCHESTRATION_MESSAGE_WAITERS,
  MAX_ORCHESTRATION_MESSAGE_WAITERS_PER_HANDLE,
  MAX_ORCHESTRATION_MESSAGE_WAITER_HANDLE_BYTES,
  MAX_ORCHESTRATION_MESSAGE_WAITER_RETAINED_HANDLE_BYTES,
  OrchestrationMessageWaiterLimitError,
  OrchestrationMessageWaiterRegistry
} from './orchestration-message-waiter-registry'

const BOUNDS = {
  maxWaiters: 3,
  maxWaitersPerHandle: 2,
  maxHandleBytes: 8,
  maxRetainedHandleBytes: 10
}

describe('OrchestrationMessageWaiterRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps global waiters and admits again after settlement', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const first = registry.wait('a')
    const second = registry.wait('b')
    const third = registry.wait('c')

    expect(() => registry.wait('d')).toThrowError(expect.objectContaining({ reason: 'global' }))
    registry.notify('a')
    await first
    const replacement = registry.wait('d')
    expect(registry.evidence()).toEqual({
      waiters: 3,
      handles: 3,
      retainedHandleBytes: 3
    })

    registry.close()
    await Promise.all([second, third, replacement])
  })

  it('caps waiters per handle without blocking another handle', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const first = registry.wait('same')
    const second = registry.wait('same')

    expect(() => registry.wait('same')).toThrowError(
      expect.objectContaining({ reason: 'per-handle' })
    )
    const other = registry.wait('other')
    expect(registry.evidence()).toEqual({
      waiters: 3,
      handles: 2,
      retainedHandleBytes: 9
    })

    registry.close()
    await Promise.all([first, second, other])
  })

  it('rejects oversized handles without retaining them', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)

    expect(() => registry.wait('🌊🌊🌊')).toThrow(OrchestrationMessageWaiterLimitError)
    expect(() => registry.wait('🌊🌊🌊')).toThrowError(
      expect.objectContaining({ reason: 'handle-bytes' })
    )
    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })

    const controller = new AbortController()
    controller.abort()
    await expect(registry.wait('🌊🌊🌊', { signal: controller.signal })).resolves.toBeUndefined()
  })

  it('accounts for each unique handle key once and caps aggregate key bytes', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const first = registry.wait('123456')
    const sameHandle = registry.wait('123456')
    const second = registry.wait('abcd')

    expect(registry.evidence()).toEqual({
      waiters: 3,
      handles: 2,
      retainedHandleBytes: 10
    })
    registry.notify('abcd')
    await second
    expect(() => registry.wait('abcde')).toThrowError(
      expect.objectContaining({ reason: 'retained-handle-bytes' })
    )

    registry.close()
    await Promise.all([first, sameHandle])
  })

  it('releases all key accounting under unique-handle churn', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)

    for (let index = 0; index < 10_000; index += 1) {
      const handle = String(index)
      const wait = registry.wait(handle)
      registry.notify(handle)
      await wait
    }

    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })
  })

  it('preserves type-filter wake behavior and deduplicates filters', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    let statusResolved = false
    let workerResolved = false
    const status = registry.wait('same', {
      typeFilter: ['status', 'status']
    })
    const worker = registry.wait('same', {
      typeFilter: ['worker_done']
    })
    void status.then(() => {
      statusResolved = true
    })
    void worker.then(() => {
      workerResolved = true
    })

    expect(registry.notify('same', 'status')).toBe(1)
    await status
    expect(statusResolved).toBe(true)
    expect(workerResolved).toBe(false)
    expect(registry.evidence()).toEqual({
      waiters: 1,
      handles: 1,
      retainedHandleBytes: 4
    })

    expect(registry.notify('same')).toBe(1)
    await worker
  })

  it('removes timeout and abort state after notification', async () => {
    vi.useFakeTimers()
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const wait = registry.wait('a', { signal: controller.signal, timeoutMs: 100 })

    registry.notify('a')
    await wait
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })
  })

  it('cleans up exactly on timeout', async () => {
    vi.useFakeTimers()
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const wait = registry.wait('abc', { signal: controller.signal, timeoutMs: 100 })

    await vi.advanceTimersByTimeAsync(100)
    await wait
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })
  })

  it('cleans up exactly on abort and does not register an already-aborted signal', async () => {
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const wait = registry.wait('abc', { signal: controller.signal })

    controller.abort()
    await wait
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const addListener = vi.spyOn(alreadyAborted.signal, 'addEventListener')
    await registry.wait('abc', { signal: alreadyAborted.signal })
    expect(addListener).not.toHaveBeenCalled()
    expect(registry.evidence().waiters).toBe(0)
  })

  it('settles every waiter and releases all accounting on close', async () => {
    vi.useFakeTimers()
    const registry = new OrchestrationMessageWaiterRegistry(BOUNDS)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const first = registry.wait('first')
    const sameHandle = registry.wait('first', { signal: controller.signal })
    const second = registry.wait('other')

    registry.close()
    await Promise.all([first, sameHandle, second])
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    expect(registry.evidence()).toEqual({
      waiters: 0,
      handles: 0,
      retainedHandleBytes: 0
    })
    await expect(registry.wait('later')).resolves.toBeUndefined()
    expect(registry.evidence().waiters).toBe(0)
  })

  it('publishes explicit production bounds', () => {
    expect(MAX_ORCHESTRATION_MESSAGE_WAITERS).toBe(1_024)
    expect(MAX_ORCHESTRATION_MESSAGE_WAITERS_PER_HANDLE).toBe(64)
    expect(MAX_ORCHESTRATION_MESSAGE_WAITER_HANDLE_BYTES).toBe(64 * 1024)
    expect(MAX_ORCHESTRATION_MESSAGE_WAITER_RETAINED_HANDLE_BYTES).toBe(1024 * 1024)
  })
})
