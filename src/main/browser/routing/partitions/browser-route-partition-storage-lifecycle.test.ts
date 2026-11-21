import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import {
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'

const fingerprint = 'a'.repeat(64)
const scopeBeta = '2'.repeat(64)

function partitionName(marker: string): string {
  return `persist:orca-browser-v1-${marker.repeat(64)}`
}

function createStore(): {
  filePath: string
  partitionDataRoot: string
  store: BrowserRoutePartitionBindingStore
} {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'orca-browser-storage-gc-')))
  const filePath = join(root, 'bindings.json')
  const partitionDataRoot = join(root, 'Partitions')
  mkdirSync(partitionDataRoot, { recursive: true })
  return {
    filePath,
    partitionDataRoot,
    store: new BrowserRoutePartitionBindingStore({ filePath })
  }
}

function seedPartitionDirectory(partitionDataRoot: string, partition: string): string {
  const directory = join(partitionDataRoot, partition.slice('persist:'.length))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'Cookies'), 'cookie-bytes')
  return directory
}

function createDependencies(
  store: BrowserRoutePartitionBindingStore,
  partitionDataRoot: string,
  live: ReadonlySet<string> = new Set()
): BrowserRoutePartitionStorageDependencies & { cleared: string[] } {
  const cleared: string[] = []
  return {
    cleared,
    bindings: store,
    partitionDataRoot,
    isPartitionLive: (partition) => live.has(partition),
    clearPartitionStorage: async (partition) => {
      cleared.push(partition)
    },
    removePartitionDirectory: (directory) => rm(directory, { recursive: true, force: true })
  }
}

describe('route partition storage lifecycle', () => {
  it('keeps the binding when storage clearing fails', async () => {
    const { store, partitionDataRoot } = createStore()
    const partition = partitionName('0')
    store.set(partition, fingerprint, scopeBeta)
    const directory = seedPartitionDirectory(partitionDataRoot, partition)
    const dependencies = createDependencies(store, partitionDataRoot)
    dependencies.clearPartitionStorage = vi.fn(async () => {
      throw new Error('session busy')
    })

    const released = await releaseBrowserRoutePartitionStorage(dependencies, [partition])

    expect(released.clearedPartitions).toEqual([])
    expect(released.failures).toHaveLength(1)
    expect(existsSync(directory)).toBe(true)
    expect(store.get(partition)).toBe(fingerprint)
  })

  it('refuses to destroy storage a live page still owns', async () => {
    const { store, partitionDataRoot } = createStore()
    const partition = partitionName('1')
    store.set(partition, fingerprint, scopeBeta)
    const directory = seedPartitionDirectory(partitionDataRoot, partition)
    const dependencies = createDependencies(store, partitionDataRoot, new Set([partition]))

    const released = await releaseBrowserRoutePartitionStorage(dependencies, [partition])

    expect(released.clearedPartitions).toEqual([])
    expect(dependencies.cleared).toEqual([])
    expect(existsSync(directory)).toBe(true)
    expect(store.get(partition)).toBe(fingerprint)
  })
})
