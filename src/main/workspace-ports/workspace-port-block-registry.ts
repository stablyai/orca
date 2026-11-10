import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
type PersistedRegistry = { version: 1; blocks: Record<string, PersistedBlock> }

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

function isValidBlock(value: unknown): value is PersistedBlock {
  if (!value || typeof value !== 'object') {
    return false
  }
  const { base, allocatedAt } = value as Record<string, unknown>
  return (
    typeof base === 'number' &&
    Number.isInteger(base) &&
    base >= WORKSPACE_PORT_RANGE_START &&
    base + WORKSPACE_PORT_BLOCK_SIZE <= WORKSPACE_PORT_RANGE_END &&
    (base - WORKSPACE_PORT_RANGE_START) % WORKSPACE_PORT_BLOCK_SIZE === 0 &&
    typeof allocatedAt === 'number'
  )
}

/**
 * One host-wide table of workspace → port block. A block never changes once allocated, so a dev
 * server keeps its URL across restarts, sleeps and app updates; two workspaces never share one.
 */
export class WorkspacePortBlockRegistry {
  private blocks: Map<string, PersistedBlock> | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** The workspace's block, allocating one on first use. */
  getBlock(worktreePath: string): WorkspacePortBlock {
    const key = normalizeRuntimePathForComparison(worktreePath)
    const cached = this.load().get(key)
    if (cached && this.now() - cached.allocatedAt < USE_REFRESH_MS) {
      return { base: cached.base, count: WORKSPACE_PORT_BLOCK_SIZE }
    }
    // Re-read before writing: another Orca process on this host may have allocated since.
    this.blocks = null
    const blocks = this.load()
    const existing = blocks.get(key)
    if (existing) {
      blocks.set(key, { base: existing.base, allocatedAt: this.now() })
      this.save(blocks)
      return { base: existing.base, count: WORKSPACE_PORT_BLOCK_SIZE }
    }
    const base = this.allocate(key, blocks)
    blocks.set(key, { base, allocatedAt: this.now() })
    this.save(blocks)
    return { base, count: WORKSPACE_PORT_BLOCK_SIZE }
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
    // Every slot is held: reclaim the oldest allocation, which belongs to a long-gone checkout.
    let oldestKey: string | null = null
    for (const [candidateKey, block] of blocks) {
      if (oldestKey === null || block.allocatedAt < blocks.get(oldestKey)!.allocatedAt) {
        oldestKey = candidateKey
      }
    }
    const reclaimed = blocks.get(oldestKey!)!.base
    blocks.delete(oldestKey!)
    return reclaimed
  }

  private load(): Map<string, PersistedBlock> {
    if (this.blocks) {
      return this.blocks
    }
    const blocks = new Map<string, PersistedBlock>()
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedRegistry>
      const seenBases = new Set<number>()
      for (const [key, block] of Object.entries(parsed.blocks ?? {})) {
        // A hand-edited duplicate keeps its first owner; the second re-allocates on next use.
        if (isValidBlock(block) && !seenBases.has(block.base)) {
          seenBases.add(block.base)
          blocks.set(key, block)
        }
      }
    } catch {
      // Missing or unreadable: start empty; allocations re-derive from the same hash.
    }
    this.blocks = blocks
    return blocks
  }

  private save(blocks: Map<string, PersistedBlock>): void {
    const payload: PersistedRegistry = { version: 1, blocks: Object.fromEntries(blocks) }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
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
export function getWorkspacePortBlock(worktreePath: string): WorkspacePortBlock | null {
  if (!worktreePath) {
    return null
  }
  return getDefaultRegistry()?.getBlock(worktreePath) ?? null
}

export function getWorkspacePortBlockForWorktreeId(worktreeId: string): WorkspacePortBlock | null {
  const parsed = splitWorktreeId(worktreeId)
  return parsed?.worktreePath ? getWorkspacePortBlock(parsed.worktreePath) : null
}
