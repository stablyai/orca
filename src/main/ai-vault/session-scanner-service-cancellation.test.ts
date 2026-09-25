import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultServiceChildMessage,
  AiVaultServiceParentMessage
} from './session-scanner-service-protocol'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'

const scanAiVaultSessions = vi.hoisted(() => vi.fn())
const flushSessionParseCachePersist = vi.hoisted(() => vi.fn(async () => undefined))
const closeSearch = vi.hoisted(() => vi.fn())

vi.mock('./session-scanner', () => ({ scanAiVaultSessions }))
vi.mock('./session-scanner-parse-cache', () => ({ invalidateSessionParseCacheEntry: vi.fn() }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist,
  initSessionParseCachePersistence: vi.fn()
}))
vi.mock('./session-scanner-service-search', () => ({
  SessionScannerServiceSearch: class {
    handles(): boolean {
      return false
    }
    close(): void {
      closeSearch()
    }
  }
}))

const result = { sessions: [], issues: [], scannedAt: '2026-09-15' }
const sent: AiVaultServiceChildMessage[] = []
const disconnect = vi.fn()
let restoreProcess = (): void => undefined

function emit(message: AiVaultServiceParentMessage): void {
  process.emit('message', message)
}

function scan(id: number): void {
  emit({ type: 'request', id, operation: 'scan', options: {} })
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function cancelAndObserveSet(id: number): Set<unknown> {
  const add = vi.spyOn(Set.prototype, 'add')
  try {
    emit({ type: 'cancel', id })
    const index = add.mock.calls.findIndex(([value]) => value === id)
    const retained = add.mock.contexts[index]
    if (!(retained instanceof Set)) {
      throw new Error('Expected an admitted cancellation.')
    }
    return retained
  } finally {
    add.mockRestore()
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  sent.length = 0
  scanAiVaultSessions.mockResolvedValue(result)
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
  const disconnectDescriptor = Object.getOwnPropertyDescriptor(process, 'disconnect')
  const messageListeners = new Set(process.listeners('message'))
  const disconnectListeners = new Set(process.listeners('disconnect'))
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (message: AiVaultServiceChildMessage) => {
      sent.push(message)
      return true
    }
  })
  Object.defineProperty(process, 'disconnect', { configurable: true, value: disconnect })
  restoreProcess = () => {
    for (const listener of process.listeners('message')) {
      if (!messageListeners.has(listener)) {
        process.removeListener('message', listener)
      }
    }
    for (const listener of process.listeners('disconnect')) {
      if (!disconnectListeners.has(listener)) {
        process.removeListener('disconnect', listener)
      }
    }
    if (sendDescriptor) {
      Object.defineProperty(process, 'send', sendDescriptor)
    } else {
      Reflect.deleteProperty(process, 'send')
    }
    if (disconnectDescriptor) {
      Object.defineProperty(process, 'disconnect', disconnectDescriptor)
    } else {
      Reflect.deleteProperty(process, 'disconnect')
    }
  }
  await import('./session-scanner-service-entry')
  emit({
    type: 'init',
    protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
    sessionParseCache: null,
    sessionSearch: null
  })
})

afterEach(async () => {
  emit({ type: 'shutdown' })
  await settle()
  restoreProcess()
})

describe('AI Vault service cancellation ownership', () => {
  it.each(['result', 'error'] as const)(
    'does not retain late cancellations after a %s response',
    async (responseType) => {
      const first = Promise.withResolvers<typeof result>()
      scanAiVaultSessions.mockReturnValueOnce(first.promise)
      scan(1)
      await settle()
      const cancelled = cancelAndObserveSet(1)
      first.resolve(result)
      await settle()
      expect(cancelled.size).toBe(0)

      if (responseType === 'error') {
        scanAiVaultSessions.mockRejectedValue(new Error('Synthetic parse failure'))
      }
      for (let id = 2; id <= 65; id++) {
        scan(id)
        await settle()
        expect(sent).toContainEqual(expect.objectContaining({ type: responseType, id }))
        // The parent can cancel while this completed response is still in transit.
        emit({ type: 'cancel', id })
      }
      emit({ type: 'cancel', id: 999 })
      expect(cancelled.size).toBe(0)
    }
  )

  it('cancels running and queued requests and releases both IDs when they settle', async () => {
    const first = Promise.withResolvers<typeof result>()
    const signals: AbortSignal[] = []
    scanAiVaultSessions.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : Promise.resolve(result)
    })
    scan(1)
    scan(2)
    await settle()
    const cancelled = cancelAndObserveSet(1)
    emit({ type: 'cancel', id: 2 })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(cancelled.size).toBe(2)
    first.resolve(result)
    await settle()
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(true)
    expect(cancelled.size).toBe(0)
    expect(sent.filter((message) => message.type === 'result')).toHaveLength(2)
  })

  it('aborts the running request and closes the service before ignoring later cancels', async () => {
    const first = Promise.withResolvers<typeof result>()
    let signal: AbortSignal | undefined
    scanAiVaultSessions.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal
      return first.promise
    })
    scan(1)
    await settle()
    const cancelled = cancelAndObserveSet(1)
    emit({ type: 'shutdown' })
    expect(signal?.aborted).toBe(true)
    first.resolve(result)
    await settle()
    expect(cancelled.size).toBe(0)
    expect(closeSearch).toHaveBeenCalledOnce()
    expect(flushSessionParseCachePersist).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    emit({ type: 'cancel', id: 1 })
    expect(cancelled.size).toBe(0)
  })
})
