import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { AI_VAULT_SERVICE_READY_TIMEOUT_MS } from './session-scanner-service-client-state'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

function setup(idleTimeoutMs?: number): {
  child: AiVaultServiceTestChild
  client: AiVaultScannerServiceClient
} {
  const child = new AiVaultServiceTestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChildProcess(),
    init: { sessionParseCache: null },
    idleTimeoutMs
  })
  return { child, client }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AiVaultScannerServiceClient', () => {
  it('waits for ready and runs cache and interactive lanes independently', async () => {
    const { child, client } = setup()
    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })
    const subagents = client.request({
      type: 'request',
      operation: 'subagents',
      request: { agent: 'claude', parentFilePath: '/tmp/parent.jsonl' }
    })

    expect(child.sent).toEqual([expect.objectContaining({ type: 'init', protocol: 1 })])
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    expect(child.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'titles' }),
        expect.objectContaining({ operation: 'subagents' })
      ])
    )

    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'subagents'),
      operation: 'subagents',
      value: { sessions: [], issues: [] }
    })
    await expect(titles).resolves.toEqual({ titles: [] })
    await expect(subagents).resolves.toEqual({ sessions: [], issues: [] })
    client.dispose()
  })

  it('bounds active and queued calls together at sixteen', async () => {
    const { child, client } = setup()
    const calls = Array.from({ length: 16 }, () =>
      client.request({ type: 'request', operation: 'titles', requests: [] })
    )

    await expect(
      client.request({ type: 'request', operation: 'titles', requests: [] })
    ).rejects.toThrow('queue is full')
    readyAiVaultServiceChild(child)
    client.dispose()
    await Promise.all(calls.map((call) => expect(call).rejects.toThrow('disposed')))
  })

  it('cancels active work and kills a child that ignores cancellation', async () => {
    vi.useFakeTimers()
    const { child, client } = setup()
    const controller = new AbortController()
    const request = client.request(
      { type: 'request', operation: 'titles', requests: [] },
      controller.signal
    )
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    const id = aiVaultServiceRequestId(child, 'titles')

    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).toContainEqual({ type: 'cancel', id })
    vi.advanceTimersByTime(1_999)
    expect(child.killed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(child.killed).toBe(true)
    client.dispose()
  })

  it('drops a call cancelled before the child received it', async () => {
    vi.useFakeTimers()
    const { child, client } = setup()
    const controller = new AbortController()
    const cancelled = client.request(
      { type: 'request', operation: 'titles', requests: [] },
      controller.signal
    )

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.sent).not.toContainEqual(expect.objectContaining({ type: 'cancel' }))

    readyAiVaultServiceChild(child)
    const next = client.request({ type: 'request', operation: 'titles', requests: [] })
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await expect(next).resolves.toEqual({ titles: [] })
    vi.advanceTimersByTime(2_000)

    expect(child.killed).toBe(false)
    client.dispose()
  })

  it('retries once when the first cold start misses the ready deadline', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(12_345 + children.length)
        children.push(child)
        return child.asChildProcess()
      },
      init: { sessionParseCache: null }
    })
    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })
    expect(children).toHaveLength(1)

    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    expect(children[0]!.killed).toBe(true)
    await Promise.resolve()
    vi.advanceTimersByTime(250)
    expect(children).toHaveLength(2)
    readyAiVaultServiceChild(children[1]!)
    await Promise.resolve()
    children[1]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[1]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })

    await expect(titles).resolves.toEqual({ titles: [] })
    client.dispose()
  })

  it('surfaces the startup error when the retried cold start also fails', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(12_345 + children.length)
        children.push(child)
        return child.asChildProcess()
      },
      init: { sessionParseCache: null }
    })
    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })

    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    await Promise.resolve()
    vi.advanceTimersByTime(250)
    expect(children).toHaveLength(2)
    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)

    await expect(titles).rejects.toThrow('did not become ready')
    client.dispose()
  })

  it('acknowledges cache invalidation through the running child', async () => {
    const { child, client } = setup()
    const invalidation = client.invalidate(['/tmp/deleted.jsonl'])
    readyAiVaultServiceChild(child)
    await vi.waitFor(() =>
      expect(child.sent).toContainEqual({
        type: 'invalidate',
        generation: 1,
        paths: ['/tmp/deleted.jsonl']
      })
    )
    child.emit('message', { type: 'invalidated', generation: 1 })

    await expect(invalidation).resolves.toBeUndefined()
    client.dispose()
  })

  it('leaves a scanning child alone when cache invalidation is slow to acknowledge', async () => {
    vi.useFakeTimers()
    const { child, client } = setup()
    const scan = client.request({ type: 'request', operation: 'scan', options: {} })
    readyAiVaultServiceChild(child)
    await Promise.resolve()

    const invalidation = client.invalidate(['/tmp/deleted.jsonl'])
    await Promise.resolve()
    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)

    // The scan owns liveness through its own 130s deadline; killing the child
    // here would abort it and burn a slot toward the restart circuit.
    await expect(invalidation).resolves.toBeUndefined()
    expect(child.killed).toBe(false)

    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'scan'),
      operation: 'scan',
      value: { result: { sessions: [], issues: [], scannedAt: '2026-08-10' }, durationMs: 1 }
    })
    await expect(scan).resolves.toMatchObject({ result: { sessions: [] } })
    client.dispose()
  })

  it('replaces a child that does not acknowledge cache invalidation', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(12_345 + children.length)
        children.push(child)
        return child.asChildProcess()
      },
      init: { sessionParseCache: null }
    })
    const invalidation = client.invalidate(['/tmp/deleted.jsonl'])
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()

    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)

    await expect(invalidation).rejects.toThrow('cache invalidation timed out')
    expect(children[0]!.killed).toBe(true)
    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(children).toHaveLength(2)
    readyAiVaultServiceChild(children[1]!)
    await Promise.resolve()
    children[1]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[1]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })

    await expect(titles).resolves.toEqual({ titles: [] })
    client.dispose()
  })

  it('keeps invalidation-only children alive through acknowledgement, then retires them', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []
    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(12_345 + children.length)
        children.push(child)
        return child.asChildProcess()
      },
      init: { sessionParseCache: null },
      idleTimeoutMs: 100
    })

    const first = client.request({ type: 'request', operation: 'titles', requests: [] })
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()
    children[0]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[0]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await first
    vi.advanceTimersByTime(100)

    const invalidation = client.invalidate(['/tmp/deleted.jsonl'])
    readyAiVaultServiceChild(children[1]!)
    await Promise.resolve()
    vi.advanceTimersByTime(100)
    expect(children[1]!.sent).not.toContainEqual({ type: 'shutdown' })
    children[1]!.emit('message', { type: 'invalidated', generation: 1 })
    await invalidation
    vi.advanceTimersByTime(100)

    expect(children[1]!.sent).toContainEqual({ type: 'shutdown' })
    client.dispose()
  })

  it('faults the child on malformed output without affecting later processes', async () => {
    const { child, client } = setup()
    const request = client.request({ type: 'request', operation: 'titles', requests: [] })
    readyAiVaultServiceChild(child)
    await Promise.resolve()

    child.emit('message', { nope: true })

    await expect(request).rejects.toThrow('malformed')
    expect(child.killed).toBe(true)
    client.dispose()
  })

  it('retires an idle child gracefully, then kills it after the shutdown bound', async () => {
    vi.useFakeTimers()
    const { child, client } = setup(100)
    const request = client.request({ type: 'request', operation: 'titles', requests: [] })
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    child.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(child, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await request

    vi.advanceTimersByTime(100)
    expect(child.sent).toContainEqual({ type: 'shutdown' })
    vi.advanceTimersByTime(2_000)
    expect(child.killed).toBe(true)
    client.dispose()
  })
})
