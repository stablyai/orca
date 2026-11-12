import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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

  it('answers to an alias beside the fingerprint older builds read', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath() })
    store.set(partition, fingerprint, 'e'.repeat(64))

    store.rebind(partition, fingerprint, 'e'.repeat(64), 'b'.repeat(64))
    store.rebind(partition, fingerprint, 'e'.repeat(64), 'b'.repeat(64))

    expect(store.findPartitionByFingerprint('b'.repeat(64))).toBe(partition)
    expect(store.findPartitionByFingerprint(fingerprint)).toBe(partition)
    expect(store.get(partition)).toBe(fingerprint)
    expect(store.listBindings().get(partition)?.aliasFingerprints).toEqual(['b'.repeat(64)])
    store.set(partition, fingerprint, 'f'.repeat(64))
    expect(store.findPartitionByFingerprint('b'.repeat(64))).toBe(partition)
  })
})
