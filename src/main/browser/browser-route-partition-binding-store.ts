import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  assertBinding,
  assertStorageScope,
  BINDING_STORE_VERSION,
  parseBindings,
  readBoundedUtf8File,
  type BrowserRoutePartitionBinding
} from './browser-route-partition-binding-file'

export type { BrowserRoutePartitionBinding } from './browser-route-partition-binding-file'

const DEFAULT_MAX_BINDINGS = 512
const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000
const PERSIST_PARTITION_PREFIX = 'persist:'

type BindingState = {
  bindings: Record<string, BrowserRoutePartitionBinding>
}

export class BrowserRoutePartitionBindingStore {
  private readonly maxBindings: number
  private readonly maxFileBytes: number
  private readonly isPartitionRetained: (partition: string) => boolean

  constructor(
    private readonly options: {
      filePath: string
      partitionDataRoot?: string
      maxBindings?: number
      maxFileBytes?: number
      /**
       * Retained partitions are never evicted: their storage is in use right now.
       * Absent means the caller cannot tell, so nothing is evictable and capacity
       * throws as before -- evicting a live partition would destroy storage in use.
       */
      isPartitionRetained?: (partition: string) => boolean
    }
  ) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.isPartitionRetained = options.isPartitionRetained ?? (() => true)
  }

  get(partition: string): string | null {
    assertBinding(partition, 'a'.repeat(64))
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    return state.bindings[partition]?.fingerprint ?? null
  }

  listBindings(): ReadonlyMap<string, BrowserRoutePartitionBinding> {
    return new Map(Object.entries(this.load().bindings))
  }

  /** Drops binding metadata for partitions whose Chromium storage was destroyed. */
  remove(partitions: readonly string[]): number {
    const state = this.load()
    const remaining = { ...state.bindings }
    let removed = 0
    for (const partition of partitions) {
      if (remaining[partition] !== undefined) {
        delete remaining[partition]
        removed += 1
      }
    }
    if (removed === 0) {
      return 0
    }
    this.persist({ bindings: remaining })
    return removed
  }

  /** Partition already bound to `fingerprint`: where that identity's storage already lives. */
  findPartitionByFingerprint(fingerprint: string): string | null {
    for (const [partition, binding] of Object.entries(this.load().bindings)) {
      if (binding.fingerprint === fingerprint) {
        return partition
      }
    }
    return null
  }

  /** Re-points a bound partition at a new fingerprint, so an identity-scheme change keeps its storage. */
  rebind(partition: string, fingerprint: string, storageScope: string): void {
    assertBinding(partition, fingerprint)
    assertStorageScope(storageScope)
    const state = this.load()
    if (state.bindings[partition] === undefined) {
      throw new Error('browser_route_partition_binding_invalid')
    }
    this.persist({
      bindings: {
        ...state.bindings,
        [partition]: { fingerprint, storageScope, lastUsedAt: Date.now() }
      }
    })
  }

  /** Records continued use, so eviction reaches abandoned partitions before live ones. */
  touch(partition: string): void {
    const state = this.load()
    const existing = state.bindings[partition]
    if (existing) {
      this.refreshIfStale(state, partition, existing)
    }
  }

  /**
   * Binds a partition, evicting least-recently-used releasable bindings at capacity.
   *
   * Returns the evicted partitions: their metadata is gone, so the caller owns
   * destroying their storage. Capacity throws only when every binding is retained.
   */
  set(partition: string, fingerprint: string, storageScope: string): readonly string[] {
    assertBinding(partition, fingerprint)
    assertStorageScope(storageScope)
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    const existing = state.bindings[partition]
    if (existing?.fingerprint === fingerprint && existing.storageScope === storageScope) {
      this.refreshIfStale(state, partition, existing)
      return []
    }
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error('browser_route_partition_binding_conflict')
    }
    const bindings = { ...state.bindings }
    const evicted: string[] = []
    while (existing === undefined && Object.keys(bindings).length >= this.maxBindings) {
      const victim = this.leastRecentlyUsedReleasable(bindings)
      if (victim === null) {
        throw new Error('browser_route_partition_binding_capacity')
      }
      delete bindings[victim]
      evicted.push(victim)
    }
    bindings[partition] = { fingerprint, storageScope, lastUsedAt: Date.now() }
    this.persist({ bindings })
    return evicted
  }

  private refreshIfStale(
    state: BindingState,
    partition: string,
    binding: BrowserRoutePartitionBinding
  ): void {
    const now = Date.now()
    // Why: preparing a page must not cost a store write, so coarse recency is enough for LRU.
    if (now - binding.lastUsedAt < TOUCH_INTERVAL_MS) {
      return
    }
    this.persist({
      bindings: { ...state.bindings, [partition]: { ...binding, lastUsedAt: now } }
    })
  }

  private leastRecentlyUsedReleasable(
    bindings: Record<string, BrowserRoutePartitionBinding>
  ): string | null {
    let victim: string | null = null
    let victimLastUsedAt = Number.POSITIVE_INFINITY
    for (const [partition, binding] of Object.entries(bindings)) {
      if (binding.lastUsedAt < victimLastUsedAt && !this.isPartitionRetained(partition)) {
        victim = partition
        victimLastUsedAt = binding.lastUsedAt
      }
    }
    return victim
  }

  private persist(state: BindingState): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    this.writeDurably(
      `${JSON.stringify({ version: BINDING_STORE_VERSION, bindings: state.bindings })}\n`
    )
  }

  private load(): BindingState {
    if (!existsSync(this.options.filePath)) {
      return { bindings: {} }
    }
    try {
      const parsed: unknown = JSON.parse(
        readBoundedUtf8File(this.options.filePath, this.maxFileBytes)
      )
      const bindings = parseBindings(parsed, this.maxBindings)
      if (!bindings) {
        throw new Error('invalid binding state')
      }
      return { bindings }
    } catch {
      throw new Error('browser_route_partition_binding_store_invalid')
    }
  }

  private assertMetadataPrecedesPartitionData(partition: string, state: BindingState): void {
    if (state.bindings[partition] !== undefined || !this.options.partitionDataRoot) {
      return
    }
    const partitionPath = join(
      this.options.partitionDataRoot,
      partition.slice(PERSIST_PARTITION_PREFIX.length)
    )
    try {
      statSync(partitionPath)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return
      }
      throw new Error('browser_route_partition_binding_store_invalid')
    }
    throw new Error('browser_route_partition_binding_store_invalid')
  }

  private writeDurably(contents: string): void {
    try {
      writeFileDurableSync(
        durableWriteTempPath(this.options.filePath),
        this.options.filePath,
        contents
      )
    } catch (error) {
      if (!isPermissionError(error) || process.platform !== 'win32') {
        throw error
      }
      grantDirAcl(dirname(this.options.filePath))
      writeFileDurableSync(
        durableWriteTempPath(this.options.filePath),
        this.options.filePath,
        contents
      )
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}
