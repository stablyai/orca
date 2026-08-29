import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import type {
  AiVaultWorkerControl,
  AiVaultWorkerRequest,
  AiVaultWorkerResponse
} from './session-scanner-worker-protocol'
import { AiVaultScannerWorkerClient } from './session-scanner-worker-client'

class FakeWorker {
  readonly posted: (AiVaultWorkerRequest | AiVaultWorkerControl)[] = []
  terminated = false
  unrefed = false
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()

  on(event: string, listener: (value: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  postMessage(message: AiVaultWorkerRequest | AiVaultWorkerControl): void {
    this.posted.push(message)
  }

  unref(): void {
    this.unrefed = true
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value)
    }
  }
}

function setup(): { client: AiVaultScannerWorkerClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  return {
    client: new AiVaultScannerWorkerClient({
      workerFactory: () => worker as unknown as Worker
    }),
    worker
  }
}

function setupWorkerFactory(): {
  client: AiVaultScannerWorkerClient
  workers: FakeWorker[]
} {
  const workers: FakeWorker[] = []
  return {
    client: new AiVaultScannerWorkerClient({
      workerFactory: () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      }
    }),
    workers
  }
}

function titleResponse(
  id: number,
  title: string
): Extract<AiVaultWorkerResponse, { kind: 'titles' }> {
  return {
    id,
    ok: true,
    kind: 'titles',
    value: { titles: [{ agent: 'codex', sessionId: 'session', title }] }
  }
}

describe('AiVaultScannerWorkerClient', () => {
  it('serializes requests in FIFO order and ignores stale responses', async () => {
    const { client, worker } = setup()
    const first = client.resolveTitles([{ agent: 'codex', sessionId: 'session' }])
    const second = client.resolveTitles([{ agent: 'claude', sessionId: 'other' }])

    expect(worker.posted).toHaveLength(1)
    const firstId = worker.posted[0]!.id
    worker.emit('message', titleResponse(999, 'stale'))
    expect(worker.posted).toHaveLength(1)

    worker.emit('message', titleResponse(firstId, 'first'))
    await expect(first).resolves.toEqual(titleResponse(firstId, 'first').value)
    expect(worker.posted).toHaveLength(2)

    const secondId = worker.posted[1]!.id
    worker.emit('message', titleResponse(secondId, 'second'))
    await expect(second).resolves.toEqual(titleResponse(secondId, 'second').value)
    expect(worker.unrefed).toBe(true)
    client.dispose()
  })

  it('cancels active work without dispatching the next call concurrently', async () => {
    const { client, worker } = setup()
    const controller = new AbortController()
    const first = client.resolveTitles(
      [{ agent: 'codex', sessionId: 'session' }],
      controller.signal
    )
    const second = client.resolveTitles([{ agent: 'claude', sessionId: 'other' }])
    const firstId = worker.posted[0]!.id

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.posted).toEqual([
      expect.objectContaining({ id: firstId, kind: 'titles' }),
      { id: firstId, kind: 'cancel' }
    ])

    worker.emit('message', titleResponse(firstId, 'ignored'))
    expect(worker.posted).toHaveLength(3)
    const secondId = worker.posted[2]!.id
    worker.emit('message', titleResponse(secondId, 'second'))
    await expect(second).resolves.toEqual(titleResponse(secondId, 'second').value)
    client.dispose()
  })

  it.each([
    ['error', new Error('worker crashed')],
    ['exit', 1]
  ] as const)('restarts queued work after a worker %s', async (event, value) => {
    const { client, workers } = setupWorkerFactory()
    const first = client.resolveTitles([{ agent: 'codex', sessionId: 'first' }])
    const second = client.resolveTitles([{ agent: 'claude', sessionId: 'second' }])

    workers[0]!.emit(event, value)

    await expect(first).rejects.toThrow()
    expect(workers).toHaveLength(2)
    expect(workers[0]!.terminated).toBe(true)
    const secondId = workers[1]!.posted[0]!.id
    workers[1]!.emit('message', titleResponse(secondId, 'second'))
    await expect(second).resolves.toEqual(titleResponse(secondId, 'second').value)
    client.dispose()
  })

  it('keeps the unrefed worker resident so incremental parse state survives idle time', async () => {
    vi.useFakeTimers()
    try {
      const { client, worker } = setup()
      const result = client.resolveTitles([{ agent: 'codex', sessionId: 'session' }])
      const requestId = worker.posted[0]!.id
      worker.emit('message', titleResponse(requestId, 'title'))
      await result

      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(worker.terminated).toBe(false)
      client.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds queued calls while one request is active', async () => {
    const { client } = setup()
    const active = client.resolveTitles([{ agent: 'codex', sessionId: 'active' }])
    const queued = Array.from({ length: 16 }, (_, index) =>
      client.resolveTitles([{ agent: 'codex', sessionId: `queued-${index}` }])
    )

    await expect(client.resolveTitles([{ agent: 'codex', sessionId: 'overflow' }])).rejects.toThrow(
      'queue is full'
    )
    client.dispose()
    await expect(active).rejects.toThrow('disposed')
    await Promise.all(queued.map((promise) => expect(promise).rejects.toThrow('disposed')))
  })

  it('terminates and rejects active and queued calls on disposal', async () => {
    const { client, worker } = setup()
    const active = client.resolveTitles([{ agent: 'codex', sessionId: 'active' }])
    const queued = client.resolveTitles([{ agent: 'claude', sessionId: 'queued' }])

    client.dispose()

    expect(worker.terminated).toBe(true)
    await expect(active).rejects.toThrow('disposed')
    await expect(queued).rejects.toThrow('disposed')
  })
})
