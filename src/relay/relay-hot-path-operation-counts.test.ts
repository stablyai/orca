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

  private countingIterator<T>(inner: MapIterator<T>): MapIterator<T> {
    const bump = (): void => {
      this.visits++
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal returned here implements next() and [Symbol.iterator](), which is the whole protocol a for..of over this wrapper reaches; no other IterableIterator member is ever called.
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
    } as MapIterator<T>
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.countingIterator(super[Symbol.iterator]())
  }

  override values(): MapIterator<V> {
    return this.countingIterator(super.values())
  }

  override get(key: K): V | undefined {
    this.getCalls++
    return super.get(key)
  }
}

type ProbedDispatcher = {
  attachClient: (w: (b: Buffer) => void) => number
  clients: Map<number, unknown>
  publicationLedger: {
    clientBytes: Map<string, number>
    readonly retainedBytes: number
    readonly relayLowBytes: number
    readonly clientHighBytes: number
    tryReserve: (m: readonly { clientKey: string; bytes: number }[]) => unknown[] | null
  }
  notifyLegacyCapacityIfLow: () => void
  activeClients: () => unknown[]
  activeClientKeys: () => string[]
  tryPublishToClients: (clients: unknown[], msg: unknown, lane: string) => boolean
  dispose: () => void
}

/** Reserves through the real lease path until aggregate retention clears the relay low-water mark. */
function loadLedgerAboveLowWater(d: ProbedDispatcher): void {
  const ledger = d.publicationLedger
  for (const clientKey of d.activeClientKeys()) {
    if (ledger.retainedBytes > ledger.relayLowBytes) {
      return
    }
    ledger.tryReserve([{ clientKey, bytes: ledger.clientHighBytes }])
  }
}

function dispatcherWithClients(clientCount: number): {
  d: ProbedDispatcher
  clients: CountingMap<number, unknown>
  ledger: CountingMap<string, number>
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ProbedDispatcher names the protected members this census reads. RelayDispatcher really has them; the compiler just will not hand them out.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: byClient is the private index this test exists to measure; the shape mirrors its declaration in client-request-aborts.ts.
    const byClient = (aborts as unknown as { byClient: Map<number, Map<string, AbortController>> })
      .byClient

    // The census must be able to find things: prove the maps really hold 160 controllers across 40
    // buckets before asserting that a teardown only touches 4 of them.
    expect(byClient.size).toBe(clientCount)
    let totalControllers = 0
    for (const bucket of byClient.values()) {
      totalControllers += bucket.size
    }
    expect(totalControllers).toBe(clientCount * inFlightPerClient)

    const index = new CountingMap<number, Map<string, AbortController>>()
    for (const [k, v] of byClient) {
      index.set(k, v)
    }
    const targetBucket = new CountingMap<string, AbortController>()
    for (const [k, v] of byClient.get(1)!) {
      targetBucket.set(k, v)
    }
    index.set(1, targetBucket)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: swaps the counting stand-in into the same private index read above.
    ;(aborts as unknown as { byClient: Map<number, unknown> }).byClient = index
    index.visits = 0
    targetBucket.visits = 0

    aborts.abortClient(1)

    expect(targetBucket.visits).toBe(inFlightPerClient)
    expect(index.visits).toBe(0)
    expect(index.has(1)).toBe(false)
  })

  // Scope: this is the idle arm, where every key has to be read whatever the call shape is. It
  // guards against a per-client lookup becoming a per-client scan; it does NOT guard the thunk --
  // the counts below are identical with and without it. The loaded arm is the next test.
  it('notifyLegacyCapacity costs exactly one ledger lookup per active client when idle', () => {
    vi.useFakeTimers()
    for (const clientCount of [50, 100, 200, 400]) {
      const { d, clients, ledger } = dispatcherWithClients(clientCount)

      d.notifyLegacyCapacityIfLow()

      expect(clients.visits, `clients enumerated at n=${clientCount}`).toBe(clientCount)
      expect(ledger.getCalls, `ledger lookups at n=${clientCount}`).toBe(clientCount)
      d.dispose()
    }
  })

  // Why the loaded ledger is the one that measures the thunk: the aggregate ceiling answers first
  // and on its own, so a caller passing an eager array has already built one key string per client
  // before learning they were never going to be read. That is the whole saving, and it is invisible
  // below the low-water mark -- which is why counting an idle dispatcher guards nothing.
  it('does not enumerate clients at all once the aggregate ceiling answers', () => {
    vi.useFakeTimers()
    for (const clientCount of [50, 100, 200, 400]) {
      const { d, clients, ledger } = dispatcherWithClients(clientCount)
      loadLedgerAboveLowWater(d)
      // The census must be able to find things: a reserve that silently failed would leave the
      // ledger idle and make every count below pass for the wrong reason.
      expect(d.publicationLedger.retainedBytes).toBeGreaterThan(d.publicationLedger.relayLowBytes)
      clients.visits = 0
      ledger.getCalls = 0

      d.notifyLegacyCapacityIfLow()

      expect(clients.visits, `clients enumerated at n=${clientCount}`).toBe(0)
      expect(ledger.getCalls, `ledger lookups at n=${clientCount}`).toBe(0)
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
