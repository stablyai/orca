import { TestChild } from './session-scanner-service-child.test-fixture'
import { runAiVaultLocalScanAttempt } from '../scan-lifecycle/ai-vault-local-scan-attempt'
import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'
import { AiVaultScanCoordinator } from '../scan-lifecycle/ai-vault-scan-coordinator'
import { rowsAreObserved } from '../scan-lifecycle/ai-vault-row-interest'

const EMPTY = { sessions: [], issues: [], scannedAt: '2026-11-13' }
afterEach(() => vi.useRealTimers())

it('enables previews for a late desktop owner without restarting an unobserved shared scan', async () => {
  vi.useFakeTimers()
  const child = new TestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChild(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const coordinator = new AiVaultScanCoordinator()
  const start: Parameters<typeof coordinator.run>[0]['start'] = (signal, _id, publish) =>
    runAiVaultLocalScanAttempt(signal, async (attempt) => {
      expect(rowsAreObserved(publish)).toBe(false)
      const result = await client.request<{ result: typeof EMPTY }>(
        { type: 'request', operation: 'scan', options: {} },
        attempt,
        { work: () => undefined, rows: publish }
      )
      return result.result
    })
  const desktop = new AbortController()
  try {
    const normal = coordinator.run({ key: 'scope', start })
    await Promise.resolve()
    child.emit('message', { type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const request = child.sent.find((entry) => entry.type === 'request')
    expect(request).toMatchObject({ options: { streamRows: false } })
    const observer = vi.fn()
    const attached = coordinator.run({
      key: 'scope',
      start,
      signal: desktop.signal,
      observeRows: observer
    })
    expect(child.sent.at(-1)).toMatchObject({ type: 'rowsInterest', observed: true })
    child.emit('message', {
      type: 'rows',
      id: request?.id,
      delta: { upserts: [], removed: ['gone'] }
    })
    expect(observer).toHaveBeenCalledOnce()
    desktop.abort()
    await expect(attached).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent.at(-1)).toMatchObject({ type: 'rowsInterest', observed: false })
    expect(child.sent.filter((entry) => entry.type === 'request')).toHaveLength(1)
    child.emit('message', {
      type: 'result',
      id: request?.id,
      operation: 'scan',
      value: { result: EMPTY, durationMs: 1, work: null }
    })
    await expect(normal).resolves.toEqual(EMPTY)
  } finally {
    client.dispose()
  }
})

it('recovers a non-forced production service call when a forced waiter arrives, once, without a duplicate pass', async () => {
  vi.useFakeTimers()
  const child = new TestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChild(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const coordinator = new AiVaultScanCoordinator()
  const start = vi.fn((signal: AbortSignal) =>
    runAiVaultLocalScanAttempt(signal, async (attempt) => {
      const value = await client.request<{ result: typeof EMPTY }>(
        { type: 'request', operation: 'scan', options: {} },
        attempt
      )
      return value.result
    })
  )
  try {
    const initial = coordinator.run({ key: 'scope', start })
    await Promise.resolve()
    child.emit('message', { type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const id = child.sent.find((entry) => entry.type === 'request')?.id
    child.emit('message', { type: 'activity', id, started: true, allowanceMs: 0 })
    await vi.advanceTimersByTimeAsync(120000)
    expect(child.sent.filter((entry) => entry.type === 'cancel')).toHaveLength(0)
    const forced = coordinator.run({ key: 'scope', force: true, start })
    await vi.advanceTimersByTimeAsync(0)
    expect(child.sent.filter((entry) => entry.type === 'cancel')).toHaveLength(1)
    child.emit('message', { type: 'error', id, message: 'cancelled', retryable: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(child.sent.filter((entry) => entry.type === 'request')).toHaveLength(2)
    const recoveredId = child.sent.findLast((entry) => entry.type === 'request')?.id
    child.emit('message', { type: 'activity', id: recoveredId, started: true, allowanceMs: 0 })
    child.emit('message', {
      type: 'result',
      id: recoveredId,
      operation: 'scan',
      value: { result: EMPTY, durationMs: 1, work: null }
    })
    await expect(Promise.all([initial, forced])).resolves.toEqual([EMPTY, EMPTY])
    expect(start).toHaveBeenCalledTimes(1)
  } finally {
    client.dispose()
  }
})

it('does not recover queued calls, healthy chunks, or a size-budgeted whole read, and terminates a second stall', async () => {
  vi.useFakeTimers()
  const child = new TestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChild(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const coordinator = new AiVaultScanCoordinator()
  const request = coordinator.run({
    key: 'scope',
    start: (signal) =>
      runAiVaultLocalScanAttempt(signal, async (attempt) => {
        const value = await client.request<{ result: typeof EMPTY }>(
          { type: 'request', operation: 'scan', options: {} },
          attempt
        )
        return value.result
      })
  })
  const rejected = expect(request).rejects.toThrow('stopped making progress')
  try {
    await Promise.resolve()
    child.emit('message', { type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: 1 })
    await vi.advanceTimersByTimeAsync(120000)
    expect(child.sent.some((entry) => entry.type === 'cancel')).toBe(false)
    const id = child.sent.find((entry) => entry.type === 'request')?.id
    const forced = coordinator.run({
      key: 'scope',
      force: true,
      start: async () => {
        throw new Error('unexpected third pass')
      }
    })
    const forcedRejected = expect(forced).rejects.toThrow('stopped making progress')
    for (let index = 0; index < 3; index++) {
      child.emit('message', { type: 'activity', id, started: true, allowanceMs: 0 })
      await vi.advanceTimersByTimeAsync(59000)
    }
    child.emit('message', { type: 'activity', id, started: true, allowanceMs: 120000 })
    await vi.advanceTimersByTimeAsync(179000)
    expect(child.sent.some((entry) => entry.type === 'cancel')).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    child.emit('message', { type: 'error', id, message: 'cancelled', retryable: true })
    await vi.advanceTimersByTimeAsync(0)
    const recoveredId = child.sent.findLast((entry) => entry.type === 'request')?.id
    child.emit('message', { type: 'activity', id: recoveredId, started: true, allowanceMs: 0 })
    await vi.advanceTimersByTimeAsync(60000)
    child.emit('message', { type: 'error', id: recoveredId, message: 'cancelled', retryable: true })
    await rejected
    await forcedRejected
    await vi.advanceTimersByTimeAsync(600000)
    expect(child.sent.filter((entry) => entry.type === 'request')).toHaveLength(2)
  } finally {
    client.dispose()
  }
})

it('forwards Refresh through an outer join to runtime-first local work and shares the recovered observation', async () => {
  vi.useFakeTimers()
  const child = new TestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChild(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const local = new AiVaultScanCoordinator()
  const outer = new AiVaultScanCoordinator()
  const start = vi.fn((signal: AbortSignal) =>
    runAiVaultLocalScanAttempt(signal, async (attempt) => {
      const result = await client.request<{ result: typeof EMPTY }>(
        { type: 'request', operation: 'scan', options: {} },
        attempt
      )
      return result.result
    })
  )
  const list = (signal?: AbortSignal, force = false) =>
    local.run({ key: 'local', force, signal, start })
  const desktopStart = (signal: AbortSignal) => list(signal)
  try {
    const runtime = list()
    await Promise.resolve()
    child.emit('message', { type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const firstId = child.sent.find((entry) => entry.type === 'request')?.id
    child.emit('message', { type: 'activity', id: firstId, started: true, allowanceMs: 0 })
    const desktop = outer.run({ key: 'desktop', aggregate: true, start: desktopStart })
    await vi.advanceTimersByTimeAsync(0)
    const refreshed = outer.run({
      key: 'desktop',
      aggregate: true,
      force: true,
      start: (signal) => list(signal, true)
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(child.sent.filter((entry) => entry.type === 'cancel')).toHaveLength(1)
    child.emit('message', { type: 'error', id: firstId, message: 'cancelled', retryable: true })
    await vi.advanceTimersByTimeAsync(0)
    const recoveredId = child.sent.findLast((entry) => entry.type === 'request')?.id
    child.emit('message', { type: 'activity', id: recoveredId, started: true, allowanceMs: 0 })
    child.emit('message', {
      type: 'result',
      id: recoveredId,
      operation: 'scan',
      value: { result: EMPTY, durationMs: 1, work: null }
    })
    await expect(Promise.all([runtime, desktop, refreshed])).resolves.toEqual([EMPTY, EMPTY, EMPTY])
    expect(start).toHaveBeenCalledOnce()
    expect(child.sent.filter((entry) => entry.type === 'request')).toHaveLength(2)
  } finally {
    client.dispose()
  }
})
