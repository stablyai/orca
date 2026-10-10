import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'

const partition =
  'persist:orca-browser-v1-1111111111111111222222222222222233333333333333334444444444444444'
const fingerprint = 'a'.repeat(64)
const otherPartition = partition.replace(/1{16}/, '5555555555555555')
const thirdPartition = partition.replace(/1{16}/, '6666666666666666')
const fourthPartition = partition.replace(/1{16}/, '7777777777777777')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function createPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'orca-browser-route-bindings-')), 'bindings.json')
}

function createStorePaths(): { filePath: string; partitionDataRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-route-store-'))
  return {
    filePath: join(root, 'profile', 'bindings.json'),
    partitionDataRoot: join(root, 'Partitions')
  }
}

describe('BrowserRoutePartitionBindingStore', () => {
  it('persists an opaque binding for restart-time collision checks', () => {
    const filePath = createPath()
    const first = new BrowserRoutePartitionBindingStore({ filePath })
    first.set(partition, fingerprint, 'e'.repeat(64))

    expect(new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toBe(fingerprint)
    const serialized = readFileSync(filePath, 'utf8')
    expect(serialized).not.toContain('authority-a')
    expect(JSON.parse(serialized)).toEqual({
      version: 2,
      bindings: {
        [partition]: {
          fingerprint,
          storageScope: 'e'.repeat(64),
          lastUsedAt: expect.any(Number)
        }
      }
    })
  })

  it('reads pre-scope v1 metadata as unscoped bindings', () => {
    const filePath = createPath()
    writeFileSync(filePath, JSON.stringify({ version: 1, bindings: { [partition]: fingerprint } }))
    const store = new BrowserRoutePartitionBindingStore({ filePath })

    expect(store.get(partition)).toBe(fingerprint)
    expect(store.listBindings().get(partition)).toEqual({
      fingerprint,
      storageScope: null,
      lastUsedAt: 0
    })
  })

  it('removes bindings and rejects a non-hex storage scope', () => {
    const filePath = createPath()
    const store = new BrowserRoutePartitionBindingStore({ filePath })
    store.set(partition, fingerprint, 'e'.repeat(64))

    expect(() => store.set(thirdPartition, fingerprint, 'z')).toThrow(
      'browser_route_partition_binding_invalid'
    )
    expect(store.remove([partition])).toBe(1)
    expect(store.remove([partition])).toBe(0)
    expect(new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toBeNull()
  })

  it('rejects replacement and invalid binding shapes', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath() })
    store.set(partition, fingerprint, 'e'.repeat(64))

    expect(() => store.set(partition, 'b'.repeat(64), 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_conflict'
    )
    expect(() => store.set('persist:unowned', fingerprint, 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_invalid'
    )
    expect(() => store.set(partition, 'short', 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_invalid'
    )
  })

  it('fails closed on corrupt or malformed persisted metadata', () => {
    const filePath = createPath()
    writeFileSync(filePath, '{broken')
    expect(() => new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toThrow(
      'browser_route_partition_binding_store_invalid'
    )

    writeFileSync(filePath, JSON.stringify({ version: 3, bindings: {} }))
    expect(() => new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toThrow(
      'browser_route_partition_binding_store_invalid'
    )
  })

  it('rejects an oversized binding file before parsing it', () => {
    const filePath = createPath()
    writeFileSync(filePath, JSON.stringify({ version: 1, bindings: {}, padding: 'x'.repeat(256) }))

    expect(() =>
      new BrowserRoutePartitionBindingStore({ filePath, maxFileBytes: 128 }).get(partition)
    ).toThrow('browser_route_partition_binding_store_invalid')
  })

  it('fails closed when Chromium data exists without matching binding metadata', () => {
    const paths = createStorePaths()
    mkdirSync(join(paths.partitionDataRoot, partition.slice('persist:'.length)), {
      recursive: true
    })
    const store = new BrowserRoutePartitionBindingStore(paths)

    expect(() => store.get(partition)).toThrow('browser_route_partition_binding_store_invalid')
    expect(() => store.set(partition, fingerprint, 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_store_invalid'
    )
  })

  it('accepts existing Chromium data only with matching durable metadata', () => {
    const paths = createStorePaths()
    const store = new BrowserRoutePartitionBindingStore(paths)
    store.set(partition, fingerprint, 'e'.repeat(64))
    mkdirSync(join(paths.partitionDataRoot, partition.slice('persist:'.length)), {
      recursive: true
    })

    expect(store.get(partition)).toBe(fingerprint)
  })

  // Why: a caller that cannot tell which partitions are in use must not evict one that is.
  it('bounds distinct persisted bindings when liveness is unknown', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath(), maxBindings: 1 })
    store.set(partition, fingerprint, 'e'.repeat(64))

    expect(() => store.set(otherPartition, 'b'.repeat(64), 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_capacity'
    )
  })

  it('evicts the least recently used releasable binding instead of failing at capacity', () => {
    const store = new BrowserRoutePartitionBindingStore({
      filePath: createPath(),
      maxBindings: 2,
      isPartitionRetained: () => false
    })
    vi.setSystemTime(1_000)
    store.set(partition, fingerprint, 'e'.repeat(64))
    vi.setSystemTime(2_000)
    store.set(otherPartition, 'b'.repeat(64), 'e'.repeat(64))

    vi.setSystemTime(3_000)
    const evicted = store.set(thirdPartition, 'c'.repeat(64), 'e'.repeat(64))

    expect(evicted).toEqual([partition])
    expect(store.get(partition)).toBeNull()
    expect(store.get(otherPartition)).toBe('b'.repeat(64))
    expect(store.get(thirdPartition)).toBe('c'.repeat(64))
  })

  it('never evicts a retained partition, and fails only when every binding is retained', () => {
    const filePath = createPath()
    const retained = new Set<string>()
    const store = new BrowserRoutePartitionBindingStore({
      filePath,
      maxBindings: 2,
      isPartitionRetained: (candidate) => retained.has(candidate)
    })
    vi.setSystemTime(1_000)
    store.set(partition, fingerprint, 'e'.repeat(64))
    vi.setSystemTime(2_000)
    store.set(otherPartition, 'b'.repeat(64), 'e'.repeat(64))
    retained.add(partition)

    vi.setSystemTime(3_000)
    expect(store.set(thirdPartition, 'c'.repeat(64), 'e'.repeat(64))).toEqual([otherPartition])
    expect(store.get(partition)).toBe(fingerprint)

    retained.add(thirdPartition)
    expect(() => store.set(fourthPartition, 'd'.repeat(64), 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_capacity'
    )
  })

  it('evicts a binding kept fresh by touch only after the untouched ones', () => {
    const filePath = createPath()
    const store = new BrowserRoutePartitionBindingStore({
      filePath,
      maxBindings: 2,
      isPartitionRetained: () => false
    })
    vi.setSystemTime(1_000)
    store.set(partition, fingerprint, 'e'.repeat(64))
    vi.setSystemTime(2_000)
    store.set(otherPartition, 'b'.repeat(64), 'e'.repeat(64))

    vi.setSystemTime(2_000 + 25 * 60 * 60 * 1000)
    store.touch(partition)
    const evicted = store.set(thirdPartition, 'c'.repeat(64), 'e'.repeat(64))

    expect(evicted).toEqual([otherPartition])
    expect(store.get(partition)).toBe(fingerprint)
  })

  it('resolves an existing partition by fingerprint and re-points it on rebind', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath() })
    store.set(partition, fingerprint, 'e'.repeat(64))

    expect(store.findPartitionByFingerprint(fingerprint)).toBe(partition)
    expect(store.findPartitionByFingerprint('b'.repeat(64))).toBeNull()

    store.rebind(partition, 'b'.repeat(64), 'e'.repeat(64))

    expect(store.findPartitionByFingerprint('b'.repeat(64))).toBe(partition)
    expect(store.get(partition)).toBe('b'.repeat(64))
    expect(() => store.rebind(otherPartition, 'c'.repeat(64), 'e'.repeat(64))).toThrow(
      'browser_route_partition_binding_invalid'
    )
  })
})
