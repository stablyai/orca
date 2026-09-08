import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtimeClientState } from '../runtime/runtime-client-state-client'
import {
  createBackendGoStorage,
  enqueueWrite,
  registerPersistenceStatusSetter,
  withRetryAndErrorStatus
} from './backend-go-storage'

vi.mock('../runtime/runtime-client-state-client', () => ({
  runtimeClientState: { get: vi.fn(), set: vi.fn() }
}))

const statusSetter = vi.fn()

beforeEach(() => {
  statusSetter.mockReset()
  registerPersistenceStatusSetter(statusSetter)
  vi.mocked(runtimeClientState.get).mockReset()
  vi.mocked(runtimeClientState.set).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  registerPersistenceStatusSetter(() => {})
})

describe('withRetryAndErrorStatus', () => {
  it('records status "error" and does not throw after 3 consecutive failures', async () => {
    vi.useFakeTimers()
    const write = vi.fn().mockRejectedValue(new Error('offline'))

    const resultPromise = withRetryAndErrorStatus('keybindings', write)
    // 3 backoff waits: 2s, 4s, 8s.
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(resultPromise).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledTimes(4)
    expect(statusSetter).toHaveBeenCalledWith('keybindings', 'pending')
    expect(statusSetter).toHaveBeenLastCalledWith('keybindings', 'error', 'offline')
  })

  it('records status "synced" after failing once then succeeding on retry', async () => {
    vi.useFakeTimers()
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)

    const resultPromise = withRetryAndErrorStatus('keybindings', write)
    await vi.advanceTimersByTimeAsync(2_000)
    await resultPromise

    expect(write).toHaveBeenCalledTimes(2)
    expect(statusSetter).toHaveBeenLastCalledWith('keybindings', 'synced')
  })
})

describe('enqueueWrite', () => {
  it('runs two writes for the same kind sequentially, not in parallel', async () => {
    const order: string[] = []
    const first = vi.fn().mockImplementation(async () => {
      order.push('first-start')
      await Promise.resolve()
      order.push('first-end')
    })
    const second = vi.fn().mockImplementation(async () => {
      order.push('second-start')
      await Promise.resolve()
      order.push('second-end')
    })

    const p1 = enqueueWrite('keybindings', first)
    const p2 = enqueueWrite('keybindings', second)
    await Promise.all([p1, p2])

    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })

  it('keeps separate queues per kind (unrelated kinds may run concurrently)', async () => {
    const order: string[] = []
    const a = vi.fn().mockImplementation(async () => {
      order.push('a-start')
      await Promise.resolve()
      order.push('a-end')
    })
    const b = vi.fn().mockImplementation(async () => {
      order.push('b-start')
      await Promise.resolve()
      order.push('b-end')
    })

    await Promise.all([enqueueWrite('keybindings', a), enqueueWrite('uiLocal', b)])

    expect(order[0]).toBe('a-start')
    expect(order[1]).toBe('b-start')
  })
})

describe('createBackendGoStorage', () => {
  it('getItem returns null (string) when runtimeClientState.get returns null', async () => {
    vi.mocked(runtimeClientState.get).mockResolvedValue(null)
    const storage = createBackendGoStorage('keybindings')

    const result = await storage.getItem('keybindings')

    expect(result).toBeNull()
    expect(runtimeClientState.get).toHaveBeenCalledWith('keybindings')
  })

  it('getItem returns the JSON-stringified value when found', async () => {
    vi.mocked(runtimeClientState.get).mockResolvedValue({ 'app.settings': ['cmd+,'] })
    const storage = createBackendGoStorage('keybindings')

    const result = await storage.getItem('keybindings')

    expect(result).toBe(JSON.stringify({ 'app.settings': ['cmd+,'] }))
  })

  it('setItem parses the JSON string and writes it through runtimeClientState.set', async () => {
    vi.mocked(runtimeClientState.set).mockResolvedValue(undefined)
    const storage = createBackendGoStorage('keybindings')

    await storage.setItem('keybindings', JSON.stringify({ 'app.settings': ['cmd+,'] }))

    expect(runtimeClientState.set).toHaveBeenCalledWith('keybindings', {
      'app.settings': ['cmd+,']
    })
    expect(statusSetter).toHaveBeenLastCalledWith('keybindings', 'synced')
  })

  it('removeItem clears the backend-go record by writing null', async () => {
    vi.mocked(runtimeClientState.set).mockResolvedValue(undefined)
    const storage = createBackendGoStorage('keybindings')

    await storage.removeItem?.('keybindings')

    expect(runtimeClientState.set).toHaveBeenCalledWith('keybindings', null)
  })
})
