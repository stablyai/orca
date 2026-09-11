import { describe, expect, it, vi, afterEach } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { ClientRequestAborts } from './client-request-aborts'

// Why operation counts and not milliseconds: each assertion below is about how many entries a hot
// path visits, which is the property. A duration is only a proxy for it, and a proxy needs a
// threshold calibrated against observed runtimes -- which makes the test about the observation.
// These counts are exact and identical under any machine load.

/** Counts entries yielded by a real Map's iterators without changing the code under test. */
class CountingMap<K, V> extends Map<K, V> {
  visits = 0
  getCalls = 0

  private countingIterator<T>(inner: IterableIterator<T>): IterableIterator<T> {
    const bump = (): void => {
      this.visits++
    }
    return {
      next(): IteratorResult<T> {
        const r = inner.next()
        if (!r.done) {
          bump()
        }
        return r
      },
      [Symbol.iterator]() {
        return this
      }
    } as IterableIterator<T>
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.countingIterator(super[Symbol.iterator]()) as MapIterator<[K, V]>
  }

  override values(): MapIterator<V> {
    return this.countingIterator(super.values()) as MapIterator<V>
  }

  override get(key: K): V | undefined {
    this.getCalls++
    return super.get(key)
  }
}

type ProbedDispatcher = {
  attachClient: (w: (b: Buffer) => void) => number
  clients: Map<number, unknown>
  publicationLedger: { clientBytes: Map<string, number> }
  notifyLegacyCapacityIfLow: () => void
  activeClients: () => unknown[]
  tryPublishToClients: (clients: unknown[], msg: unknown, lane: string) => boolean
  dispose: () => void
}

function dispatcherWithClients(clientCount: number): {
  d: ProbedDispatcher
  clients: CountingMap<number, unknown>
  ledger: CountingMap<string, number>
} {
  const d = new RelayDispatcher(() => {}) as unknown as ProbedDispatcher
  for (let i = 1; i < clientCount; i++) {
    d.attachClient(() => {})
  }
  const clients = new CountingMap<number, unknown>()
  for (const [k, v] of d.clients) {
    clients.set(k, v)
  }
  d.clients = clients
  const ledger = new CountingMap<string, number>()
  d.publicationLedger.clientBytes = ledger
  clients.visits = 0
  ledger.getCalls = 0
  return { d, clients, ledger }
}

describe('relay hot-path operation counts', () => {
  afterEach(() => vi.useRealTimers())

  // Why this is the guard and not a duration: abortClient runs on every closeClient and every
  // setWrite. Under the flat composite-key map it replaced, one client's teardown enumerated every
  // controller in the relay, so a full churn of N clients holding K requests cost K*N*(N+1)/2 visits
  // -- measured at 50 -> 5,100, 100 -> 20,200, 200 -> 80,400, 400 -> 320,800, exactly 4x per
  // doubling. Teardown must now visit only what the client owns, and must not enumerate the client
  // index at all: enumerating it *is* the old scan.
  it('abortClient visits only the target client, and never enumerates the client index', () => {
    const clientCount = 40
    const inFlightPerClient = 4
    const aborts = new ClientRequestAborts()
    for (let c = 1; c <= clientCount; c++) {
      for (let r = 1; r <= inFlightPerClient; r++) {
        aborts.create(c, r)
      }
    }
    const byClient = (aborts as unknown as { byClient: Map<number, Map<number, AbortController>> })
      .byClient

    // The census must be able to find things: prove the maps really hold 160 controllers across 40
    // buckets before asserting that a teardown only touches 4 of them.
    expect(byClient.size).toBe(clientCount)
    let totalControllers = 0
    for (const bucket of byClient.values()) {
      totalControllers += bucket.size
    }
    expect(totalControllers).toBe(clientCount * inFlightPerClient)

    const index = new CountingMap<number, Map<number, AbortController>>()
    for (const [k, v] of byClient) {
      index.set(k, v)
    }
    const targetBucket = new CountingMap<number, AbortController>()
    for (const [k, v] of byClient.get(1)!) {
      targetBucket.set(k, v)
    }
    index.set(1, targetBucket)
    ;(aborts as unknown as { byClient: Map<number, unknown> }).byClient = index
    index.visits = 0
    targetBucket.visits = 0

    aborts.abortClient(1)

    expect(targetBucket.visits).toBe(inFlightPerClient)
    expect(index.visits).toBe(0)
    expect(index.has(1)).toBe(false)
  })

  it('notifyLegacyCapacity costs exactly one ledger lookup per active client', () => {
    vi.useFakeTimers()
    for (const clientCount of [50, 100, 200, 400]) {
      const { d, clients, ledger } = dispatcherWithClients(clientCount)

      d.notifyLegacyCapacityIfLow()

      expect(clients.visits, `clients enumerated at n=${clientCount}`).toBe(clientCount)
      expect(ledger.getCalls, `ledger lookups at n=${clientCount}`).toBe(clientCount)
      d.dispose()
    }
  })

  it('one broadcast publication costs a fixed number of lookups per subscriber', () => {
    vi.useFakeTimers()
    for (const clientCount of [10, 20, 40]) {
      const { d, clients, ledger } = dispatcherWithClients(clientCount)

      d.tryPublishToClients(
        d.activeClients(),
        { jsonrpc: '2.0', method: 'pty.data', params: { d: 'x' } },
        'bulk'
      )

      expect(clients.visits, `clients enumerated at n=${clientCount}`).toBe(clientCount * 2)
      expect(ledger.getCalls, `ledger lookups at n=${clientCount}`).toBe(clientCount * 4)
      d.dispose()
    }
  })
})
