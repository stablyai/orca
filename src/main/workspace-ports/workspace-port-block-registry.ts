import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  WORKSPACE_PORT_BLOCK_SIZE,
  WORKSPACE_PORT_RANGE_END,
  WORKSPACE_PORT_RANGE_START,
  type WorkspacePortBlock
} from '../../shared/workspace-port-block'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

/** `allocatedAt` is refreshed at most daily while the workspace is used, so eviction is LRU. */
type PersistedBlock = { base: number; allocatedAt: number }

const USE_REFRESH_MS = 24 * 60 * 60 * 1000
const SLOT_COUNT = Math.floor(
  (WORKSPACE_PORT_RANGE_END - WORKSPACE_PORT_RANGE_START) / WORKSPACE_PORT_BLOCK_SIZE
)

/** FNV-1a: the same path prefers the same slot on every host, so a block rarely moves. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function slotBase(slot: number): number {
  return WORKSPACE_PORT_RANGE_START + slot * WORKSPACE_PORT_BLOCK_SIZE
}

function readBlock(value: unknown): PersistedBlock | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { base, allocatedAt }: Record<string, unknown> = { ...value }
  if (
    typeof base !== 'number' ||
    !Number.isInteger(base) ||
    base < WORKSPACE_PORT_RANGE_START ||
    base + WORKSPACE_PORT_BLOCK_SIZE > WORKSPACE_PORT_RANGE_END ||
    (base - WORKSPACE_PORT_RANGE_START) % WORKSPACE_PORT_BLOCK_SIZE !== 0 ||
    typeof allocatedAt !== 'number'
  ) {
    return null
  }
  return { base, allocatedAt }
}

function parseRegistry(text: string): Map<string, PersistedBlock> {
  const blocks = new Map<string, PersistedBlock>()
  const parsed: unknown = JSON.parse(text)
  const entries =
    typeof parsed === 'object' && parsed !== null && 'blocks' in parsed ? parsed.blocks : null
  if (typeof entries !== 'object' || entries === null) {
    return blocks
  }
  const seenBases = new Set<number>()
  for (const [key, value] of Object.entries(entries)) {
    const block = readBlock(value)
    // A hand-edited duplicate keeps its first owner; the second re-allocates on next use.
    if (block && !seenBases.has(block.base)) {
      seenBases.add(block.base)
      blocks.set(key, block)
    }
  }
  return blocks
}

function toBlock(base: number): WorkspacePortBlock {
  return { base, count: WORKSPACE_PORT_BLOCK_SIZE }
}

/**
 * One host-wide table of workspace → port block. A block never changes once allocated, so a dev
 * server keeps its URL across restarts, sleeps and app updates; two workspaces never share one.
 * All file I/O is async and serialized, so allocation never blocks the main or orcad loop.
 */
export class WorkspacePortBlockRegistry {
  private blocks: Map<string, PersistedBlock> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** The block already known in memory, without touching disk (null until first allocation). */
  peekBlock(worktreePath: string): WorkspacePortBlock | null {
    const block = this.blocks?.get(normalizeRuntimePathForComparison(worktreePath))
    return block ? toBlock(block.base) : null
  }

  /** The workspace's block, allocating one on first use. */
  getBlock(worktreePath: string): Promise<WorkspacePortBlock> {
    const key = normalizeRuntimePathForComparison(worktreePath)
    const cached = this.blocks?.get(key)
    if (cached && this.now() - cached.allocatedAt < USE_REFRESH_MS) {
      return Promise.resolve(toBlock(cached.base))
    }
    const next = this.queue.then(() => this.allocateOrRefresh(key))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async allocateOrRefresh(key: string): Promise<WorkspacePortBlock> {
    // Re-read before writing: another Orca process on this host may have allocated since.
    const blocks = await this.load()
    const existing = blocks.get(key)
    const base = existing?.base ?? this.allocate(key, blocks)
    blocks.set(key, { base, allocatedAt: this.now() })
    this.blocks = blocks
    await this.save(blocks)
    return toBlock(base)
  }

  private allocate(key: string, blocks: Map<string, PersistedBlock>): number {
    const taken = new Set([...blocks.values()].map((block) => block.base))
    const preferred = hashKey(key) % SLOT_COUNT
    for (let offset = 0; offset < SLOT_COUNT; offset++) {
      const base = slotBase((preferred + offset) % SLOT_COUNT)
      if (!taken.has(base)) {
        return base
      }
    }
    // Every slot is held: reclaim the least recently used one, which belongs to a long-gone checkout.
    let oldestKey = ''
    let oldest: PersistedBlock = { base: slotBase(preferred), allocatedAt: Infinity }
    for (const [candidateKey, block] of blocks) {
      if (block.allocatedAt < oldest.allocatedAt) {
        oldestKey = candidateKey
        oldest = block
      }
    }
    blocks.delete(oldestKey)
    return oldest.base
  }

  private async load(): Promise<Map<string, PersistedBlock>> {
    try {
      return parseRegistry(await readFile(this.filePath, 'utf8'))
    } catch {
      // Missing or unreadable: keep what this process knows; allocations re-derive from the hash.
      return new Map(this.blocks ?? [])
    }
  }

  private async save(blocks: Map<string, PersistedBlock>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      const payload = { version: 1, blocks: Object.fromEntries(blocks) }
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8')
      await rename(tmp, this.filePath)
    } catch {
      // A read-only profile still hands out consistent blocks for this process's lifetime.
    }
  }
}

let defaultRegistry: WorkspacePortBlockRegistry | null = null

function getDefaultRegistry(): WorkspacePortBlockRegistry | null {
  if (!defaultRegistry) {
    try {
      defaultRegistry = new WorkspacePortBlockRegistry(
        join(getCanonicalUserDataPath(), 'workspace-port-blocks.json')
      )
    } catch {
      return null
    }
  }
  return defaultRegistry
}

/** Null when the host has no profile directory to keep allocations stable in. */
export async function getWorkspacePortBlockForWorktreeId(
  worktreeId: string
): Promise<WorkspacePortBlock | null> {
  const path = splitWorktreeId(worktreeId)?.worktreePath
  const registry = path ? getDefaultRegistry() : null
  return registry && path ? registry.getBlock(path) : null
}

/** For synchronous callers (setup/archive env): known once any terminal in the workspace opened. */
export function peekWorkspacePortBlock(worktreePath: string): WorkspacePortBlock | null {
  return worktreePath ? (getDefaultRegistry()?.peekBlock(worktreePath) ?? null) : null
}
