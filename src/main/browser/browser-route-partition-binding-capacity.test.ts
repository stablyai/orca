import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'

const storageScope = 'e'.repeat(64)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function createPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'orca-browser-route-binding-capacity-')), 'bindings.json')
}

function partitionAt(index: number): string {
  return `persist:orca-browser-v1-${index.toString(16).padStart(64, '0')}`
}

/** Persisted v2 state, written directly so entry shapes older builds wrote can be replayed. */
function writeBindings(filePath: string, bindings: Record<string, unknown>): void {
  writeFileSync(filePath, JSON.stringify({ version: 2, bindings }))
}

describe('browser route partition binding capacity', () => {
  // Why: the cap bounds the persisted file and the eviction sweep; a wider default accepts
  // state the store is meant to refuse.
  it('defaults the binding cap to 512 entries', () => {
    const atCap = createPath()
    const overCap = createPath()
    const entry = { fingerprint: 'a'.repeat(64), storageScope, lastUsedAt: 1 }
    writeBindings(
      atCap,
      Object.fromEntries(Array.from({ length: 512 }, (_, index) => [partitionAt(index), entry]))
    )
    writeBindings(
      overCap,
      Object.fromEntries(Array.from({ length: 513 }, (_, index) => [partitionAt(index), entry]))
    )

    expect(new BrowserRoutePartitionBindingStore({ filePath: atCap }).listBindings().size).toBe(512)
    expect(() =>
      new BrowserRoutePartitionBindingStore({ filePath: overCap }).listBindings()
    ).toThrow('browser_route_partition_binding_store_invalid')
  })

  // Why: a partition just adopted from the pre-migration name holds the user's live session,
  // so recording the adoption must not leave it looking like the oldest entry.
  it('counts an adopted binding as used when it is rebound', () => {
    const store = new BrowserRoutePartitionBindingStore({
      filePath: createPath(),
      maxBindings: 2,
      isPartitionRetained: () => false
    })
    vi.setSystemTime(1_000)
    store.set(partitionAt(1), 'a'.repeat(64), storageScope)
    vi.setSystemTime(2_000)
    store.set(partitionAt(2), 'b'.repeat(64), storageScope)

    vi.setSystemTime(3_000)
    store.rebind(partitionAt(1), 'c'.repeat(64), storageScope)
    const evicted = store.set(partitionAt(3), 'd'.repeat(64), storageScope)

    expect(evicted).toEqual([partitionAt(2)])
    expect(store.get(partitionAt(1))).toBe('c'.repeat(64))
  })

  // Why: an entry written before the store recorded recency has no claim on being fresh,
  // and treating it as current would evict a genuinely newer partition instead.
  it('evicts an entry with no recorded recency first', () => {
    const filePath = createPath()
    writeBindings(filePath, {
      [partitionAt(1)]: { fingerprint: 'a'.repeat(64), storageScope },
      [partitionAt(2)]: { fingerprint: 'b'.repeat(64), storageScope, lastUsedAt: 5_000 }
    })
    const store = new BrowserRoutePartitionBindingStore({
      filePath,
      maxBindings: 2,
      isPartitionRetained: () => false
    })

    expect(store.listBindings().get(partitionAt(1))?.lastUsedAt).toBe(0)

    vi.setSystemTime(9_000)
    expect(store.set(partitionAt(3), 'd'.repeat(64), storageScope)).toEqual([partitionAt(1)])
  })
})
