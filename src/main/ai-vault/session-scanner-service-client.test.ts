import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { AI_VAULT_SERVICE_READY_TIMEOUT_MS } from './session-scanner-service-client-state'
import type { AiVaultSessionSearchInit } from './session-scanner-service-protocol'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

const SESSION_SEARCH_ON: AiVaultSessionSearchInit = {
  databasePath: '/data/ai-vault/session-search.sqlite',
  settings: { enabled: true, historyDays: null },
  roots: {}
}

/** Every fork the client makes, so a respawn can be told from the first start. */
function setupChildren(policy: () => AiVaultSessionSearchInit | null): {
  children: AiVaultServiceTestChild[]
  client: AiVaultScannerServiceClient
} {
  const children: AiVaultServiceTestChild[] = []

  const client = new AiVaultScannerServiceClient({
    processFactory: () => {
      const child = new AiVaultServiceTestChild(12_345 + children.length)
      children.push(child)

      return child.asChildProcess()
    },
    init: () => ({ sessionParseCache: null, sessionSearch: policy() })
  })

  return { children, client }
}

function setup(idleTimeoutMs?: number): {
  child: AiVaultServiceTestChild
  client: AiVaultScannerServiceClient
} {
  const child = new AiVaultServiceTestChild()

  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChildProcess(),
    init: () => ({ sessionParseCache: null, sessionSearch: null }),
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
      init: () => ({ sessionParseCache: null, sessionSearch: null })
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
      init: () => ({ sessionParseCache: null, sessionSearch: null })
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

  it('starts a queued retry immediately when a forced refresh clears backoff', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []

    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(18_345 + children.length)
        children.push(child)

        return child.asChildProcess()
      },
      init: () => ({ sessionParseCache: null, sessionSearch: null })
    })

    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })

    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    await Promise.resolve()
    expect(children).toHaveLength(1)

    client.clearRestartCircuit()
    expect(children).toHaveLength(2)

    readyAiVaultServiceChild(children[1]!)
    await vi.waitFor(() =>
      expect(children[1]!.sent).toContainEqual(expect.objectContaining({ operation: 'titles' }))
    )
    children[1]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[1]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await expect(titles).resolves.toEqual({ titles: [] })
    client.dispose()
  })

  it('lets a forced refresh reopen the circuit instead of waiting out the window', async () => {
    vi.useFakeTimers()
    const children: AiVaultServiceTestChild[] = []

    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(22_345 + children.length)
        children.push(child)

        return child.asChildProcess()
      },
      init: () => ({ sessionParseCache: null, sessionSearch: null })
    })

    // Each request retries its cold start once, so two requests spend the three
    // faults the circuit breaker needs.
    const first = client.request({ type: 'request', operation: 'titles', requests: [] })
    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    await Promise.resolve()
    vi.advanceTimersByTime(250)
    await Promise.resolve()
    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    await expect(first).rejects.toThrow('did not become ready')
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()

    const blocked = client.request({ type: 'request', operation: 'titles', requests: [] })
    vi.advanceTimersByTime(AI_VAULT_SERVICE_READY_TIMEOUT_MS)
    await Promise.resolve()
    vi.advanceTimersByTime(5_000)
    expect(children).toHaveLength(3)

    client.clearRestartCircuit()
    await vi.waitFor(() => expect(children).toHaveLength(4))
    readyAiVaultServiceChild(children[3]!)
    await vi.waitFor(() =>
      expect(children[3]!.sent).toContainEqual(expect.objectContaining({ operation: 'titles' }))
    )
    children[3]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[3]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await expect(blocked).resolves.toEqual({ titles: [] })
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
      init: () => ({ sessionParseCache: null, sessionSearch: null })
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
      init: () => ({ sessionParseCache: null, sessionSearch: null }),
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

  // The child holds the index while the setting is on, and its reconcile loop is
  // invisible from here: retiring it would stop indexing until the next scan
  // happened to respawn one, which is not a guarantee anyone stated.
  it('spawns a child for the index and never retires it while the index is on', async () => {
    vi.useFakeTimers()
    const { child, client } = setup(100)

    const on = {
      databasePath: '/data/ai-vault/session-search.sqlite',
      settings: { enabled: true, historyDays: null },
      roots: {}
    }

    // No request outstanding: turning the index on is itself what spawns a child.
    client.updateSessionSearch(on)
    readyAiVaultServiceChild(child)
    await Promise.resolve()
    expect(child.sent).toContainEqual(expect.objectContaining({ type: 'init' }))

    vi.advanceTimersByTime(10_000)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })

    // A live child hears the change directly rather than waiting for a respawn.
    const narrowed = { ...on, settings: { enabled: true, historyDays: 30 } }
    client.updateSessionSearch(narrowed)
    expect(child.sent).toContainEqual({ type: 'sessionSearch', init: narrowed })
    vi.advanceTimersByTime(10_000)
    expect(child.sent).not.toContainEqual({ type: 'shutdown' })

    client.updateSessionSearch({ ...on, settings: { enabled: false, historyDays: null } })
    vi.advanceTimersByTime(100)
    expect(child.sent).toContainEqual({ type: 'shutdown' })
    client.dispose()
  })

  it('re-reads the init frame on every spawn so a respawn sees current consent', async () => {
    const children: AiVaultServiceTestChild[] = []
    let enabled = false

    const client = new AiVaultScannerServiceClient({
      processFactory: () => {
        const child = new AiVaultServiceTestChild(12_345 + children.length)
        children.push(child)

        return child.asChildProcess()
      },
      init: () => ({
        sessionParseCache: null,
        sessionSearch: {
          databasePath: '/data/ai-vault/session-search.sqlite',
          settings: { enabled, historyDays: null },
          roots: {}
        }
      })
    })

    const first = client.request({ type: 'request', operation: 'titles', requests: [] })
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()
    expect(children[0]!.sent[0]).toMatchObject({ sessionSearch: { settings: { enabled: false } } })

    enabled = true
    children[0]!.emit('error', new Error('crashed'))
    await expect(first).rejects.toThrow('crashed')
    void client.request({ type: 'request', operation: 'titles', requests: [] }).catch(() => {})
    await vi.waitFor(() => expect(children.length).toBeGreaterThan(1))

    for (const respawned of children.slice(1)) {
      expect(respawned.sent[0]).toMatchObject({ sessionSearch: { settings: { enabled: true } } })
    }

    client.dispose()
  })

  // The hold is the only thing keeping this child alive, so nothing else will
  // restart it: without its own restart, an idle indexing child that crashes
  // leaves the index stopped until some unrelated request happens to arrive.
  it('restarts a child that faulted while the index was holding it', async () => {
    vi.useFakeTimers()
    const { children, client } = setupChildren(() => SESSION_SEARCH_ON)
    client.updateSessionSearch(SESSION_SEARCH_ON)
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()

    // No queued call and no outstanding invalidation: an idle child simply dies.
    children[0]!.emit('error', new Error('crashed'))
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(250)

    expect(children).toHaveLength(2)
    expect(children[1]!.sent[0]).toMatchObject({
      type: 'init',
      sessionSearch: { settings: { enabled: true } }
    })
    client.dispose()
  })

  it.each([false, true])(
    'waits for circuit expiry before restarting a held child (dispose=%s)',
    async (dispose) => {
      vi.useFakeTimers()
      const { children, client } = setupChildren(() => SESSION_SEARCH_ON)

      try {
        client.updateSessionSearch(SESSION_SEARCH_ON)

        for (const delay of [250, 1_000]) {
          readyAiVaultServiceChild(children.at(-1)!)
          await Promise.resolve()
          children.at(-1)!.emit('error', new Error('temporary fault'))
          await vi.advanceTimersByTimeAsync(delay)
        }

        expect(children).toHaveLength(3)
        readyAiVaultServiceChild(children[2]!)
        await Promise.resolve()
        children[2]!.emit('error', new Error('temporary fault'))
        await vi.advanceTimersByTimeAsync(59_999)
        expect(children).toHaveLength(3)

        if (dispose) {
          client.dispose()
        }

        await vi.advanceTimersByTimeAsync(1)
        expect(children).toHaveLength(dispose ? 3 : 4)

        if (!dispose) {
          readyAiVaultServiceChild(children[3]!)
        }
      } finally {
        client.dispose()
      }
    }
  )

  it('leaves a faulted idle child dead while the index is off', async () => {
    vi.useFakeTimers()
    const { children, client } = setupChildren(() => null)
    const titles = client.request({ type: 'request', operation: 'titles', requests: [] })
    readyAiVaultServiceChild(children[0]!)
    await Promise.resolve()
    children[0]!.emit('message', {
      type: 'result',
      id: aiVaultServiceRequestId(children[0]!, 'titles'),
      operation: 'titles',
      value: { titles: [] }
    })
    await titles

    children[0]!.emit('error', new Error('crashed'))
    vi.advanceTimersByTime(5_000)

    expect(children).toHaveLength(1)
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
