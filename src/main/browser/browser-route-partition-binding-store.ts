import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grantDirAcl, isPermissionError } from '../win32-utils'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { isBrowserRoutePartition } from './browser-route-identity'

const BINDING_STORE_VERSION = 1
const DEFAULT_MAX_BINDINGS = 512
const DEFAULT_MAX_FILE_BYTES = 128 * 1024
const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const PERSIST_PARTITION_PREFIX = 'persist:'

type BindingState = {
  version: typeof BINDING_STORE_VERSION
  bindings: Record<string, string>
}

export class BrowserRoutePartitionBindingStore {
  private readonly maxBindings: number
  private readonly maxFileBytes: number

  constructor(
    private readonly options: {
      filePath: string
      partitionDataRoot?: string
      maxBindings?: number
      maxFileBytes?: number
    }
  ) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  get(partition: string): string | null {
    assertBinding(partition, 'a'.repeat(64))
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    return state.bindings[partition] ?? null
  }

  set(partition: string, fingerprint: string): void {
    assertBinding(partition, fingerprint)
    const state = this.load()
    this.assertMetadataPrecedesPartitionData(partition, state)
    const existing = state.bindings[partition]
    if (existing === fingerprint) {
      return
    }
    if (existing !== undefined) {
      throw new Error('browser_route_partition_binding_conflict')
    }
    if (Object.keys(state.bindings).length >= this.maxBindings) {
      throw new Error('browser_route_partition_binding_capacity')
    }
    const next: BindingState = {
      version: BINDING_STORE_VERSION,
      bindings: { ...state.bindings, [partition]: fingerprint }
    }
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    this.writeDurably(`${JSON.stringify(next)}\n`)
  }

  private load(): BindingState {
    if (!existsSync(this.options.filePath)) {
      return { version: BINDING_STORE_VERSION, bindings: {} }
    }
    try {
      const parsed: unknown = JSON.parse(
        readBoundedUtf8File(this.options.filePath, this.maxFileBytes)
      )
      if (!isBindingState(parsed, this.maxBindings)) {
        throw new Error('invalid binding state')
      }
      return parsed
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

function readBoundedUtf8File(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('binding file size invalid')
    }
    const contents = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(fd, contents, offset, size - offset, null)
      if (bytesRead === 0) {
        throw new Error('binding file truncated')
      }
      offset += bytesRead
    }
    const overflowProbe = Buffer.alloc(1)
    if (readSync(fd, overflowProbe, 0, 1, null) !== 0) {
      throw new Error('binding file grew during read')
    }
    return contents.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function isBindingState(value: unknown, maxBindings: number): value is BindingState {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<BindingState>
  if (
    candidate.version !== BINDING_STORE_VERSION ||
    !candidate.bindings ||
    typeof candidate.bindings !== 'object' ||
    Array.isArray(candidate.bindings)
  ) {
    return false
  }
  const entries = Object.entries(candidate.bindings)
  return (
    entries.length <= maxBindings &&
    entries.every(([partition, fingerprint]) => {
      try {
        assertBinding(partition, fingerprint)
        return true
      } catch {
        return false
      }
    })
  )
}

function assertBinding(partition: string, fingerprint: string): void {
  if (!isBrowserRoutePartition(partition) || !FINGERPRINT_RE.test(fingerprint)) {
    throw new Error('browser_route_partition_binding_invalid')
  }
}
