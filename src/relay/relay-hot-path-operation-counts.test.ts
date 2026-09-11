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

  // Why this matters: abortClient runs on every client close and every setWrite. It scans the
  // whole controller map to find one client's keys, so closing N clients that each hold K
  // in-flight requests costs K*N*(N+1)/2 key visits -- quadratic in the number of clients, not
  // linear. Measured: 50 -> 5,100, 100 -> 20,200, 200 -> 80,400, 400 -> 320,800 (4x per doubling).
  it('abortClient visits every controller, not just the target client', () => {
    const aborts = new ClientRequestAborts()
    const controllers = new CountingMap<string, AbortController>()
    ;(aborts as unknown as { controllers: Map<string, AbortController> }).controllers = controllers
    const clientCount = 40
    const inFlightPerClient = 4
    for (let c = 1; c <= clientCount; c++) {
      for (let r = 1; r <= inFlightPerClient; r++) {
        aborts.create(c, r)
      }
    }

    controllers.visits = 0
    aborts.abortClient(1)

    // One client's teardown enumerated the whole map, not its own 4 entries.
    expect(controllers.visits).toBe(clientCount * inFlightPerClient)
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
