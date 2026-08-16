import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'

const partition =
  'persist:orca-browser-v1-1111111111111111222222222222222233333333333333334444444444444444'
const fingerprint = 'a'.repeat(64)

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
    first.set(partition, fingerprint)

    expect(new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toBe(fingerprint)
    const serialized = readFileSync(filePath, 'utf8')
    expect(serialized).not.toContain('authority-a')
    expect(JSON.parse(serialized)).toEqual({ version: 1, bindings: { [partition]: fingerprint } })
  })

  it('rejects replacement and invalid binding shapes', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath() })
    store.set(partition, fingerprint)

    expect(() => store.set(partition, 'b'.repeat(64))).toThrow(
      'browser_route_partition_binding_conflict'
    )
    expect(() => store.set('persist:unowned', fingerprint)).toThrow(
      'browser_route_partition_binding_invalid'
    )
    expect(() => store.set(partition, 'short')).toThrow('browser_route_partition_binding_invalid')
  })

  it('fails closed on corrupt or malformed persisted metadata', () => {
    const filePath = createPath()
    writeFileSync(filePath, '{broken')
    expect(() => new BrowserRoutePartitionBindingStore({ filePath }).get(partition)).toThrow(
      'browser_route_partition_binding_store_invalid'
    )

    writeFileSync(filePath, JSON.stringify({ version: 2, bindings: {} }))
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
    expect(() => store.set(partition, fingerprint)).toThrow(
      'browser_route_partition_binding_store_invalid'
    )
  })

  it('accepts existing Chromium data only with matching durable metadata', () => {
    const paths = createStorePaths()
    const store = new BrowserRoutePartitionBindingStore(paths)
    store.set(partition, fingerprint)
    mkdirSync(join(paths.partitionDataRoot, partition.slice('persist:'.length)), {
      recursive: true
    })

    expect(store.get(partition)).toBe(fingerprint)
  })

  it('bounds distinct persisted bindings', () => {
    const store = new BrowserRoutePartitionBindingStore({ filePath: createPath(), maxBindings: 1 })
    store.set(partition, fingerprint)
    const secondPartition = partition.replace(/1{16}/, '5555555555555555')

    expect(() => store.set(secondPartition, 'b'.repeat(64))).toThrow(
      'browser_route_partition_binding_capacity'
    )
  })
})
