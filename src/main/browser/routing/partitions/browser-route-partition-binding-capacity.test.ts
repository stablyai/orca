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

function writeBindings(filePath: string, bindings: Record<string, unknown>): void {
  writeFileSync(filePath, JSON.stringify({ version: 2, bindings }))
}

describe('browser route partition binding capacity', () => {
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

  it('rejects an over-capacity file and evicts a binding without recency from a full store', () => {
    const filePath = createPath()
    writeBindings(filePath, {
      [partitionAt(1)]: { fingerprint: 'a'.repeat(64), storageScope },
      [partitionAt(2)]: { fingerprint: 'b'.repeat(64), storageScope, lastUsedAt: 5_000 }
    })
    expect(() =>
      new BrowserRoutePartitionBindingStore({ filePath, maxBindings: 1 }).listBindings()
    ).toThrow('browser_route_partition_binding_store_invalid')

    const store = new BrowserRoutePartitionBindingStore({
      filePath,
      maxBindings: 2,
      isPartitionRetained: () => false
    })

    vi.setSystemTime(9_000)
    expect(store.set(partitionAt(3), 'd'.repeat(64), storageScope)).toEqual([partitionAt(1)])
  })
})
