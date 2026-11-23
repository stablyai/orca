import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

const RESERVE_BYTES = 512 * 1024 * 1024
const QUOTA_BYTES = 4 * 1024 * 1024 * 1024
const OPERATION_PREFIX = 'operation-'
// Windows holds a just-closed SQLite file briefly; Node retries EBUSY/EPERM removals.
const REMOVAL = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const

export type ClaudeImportScratchOptions = {
  parent?: string
  quotaBytes?: number
  reserveBytes?: number
}

const active = new Set<() => void>()
let exitHookInstalled = false

function scratchParent(options: ClaudeImportScratchOptions): string {
  const uid = process.getuid?.()
  return (
    options.parent ?? join(tmpdir(), `orca-claude-imports${uid === undefined ? '' : `-${uid}`}`)
  )
}

// A shared temp folder could hold another user's directory or link under our name.
function ownedParent(parent: string): void {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const stat = lstatSync(parent)
  const uid = process.getuid?.()
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new ClaudeImportResourceError('Claude history import scratch is not owned by this user.')
  }
}

function bytes(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    try {
      total += entry.isDirectory() ? bytes(child) : lstatSync(child).size
    } catch {
      // Removed while we counted.
    }
  }
  return total
}

function ownerIsDead(path: string): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(join(path, 'owner'), 'utf8'))
  } catch {
    // No owner yet may be a live import between mkdtemp and its owner write.
    return false
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/** Remove only operations whose recorded owner process is gone; anything else stays charged. */
export function sweepClaudeImportScratch(options: ClaudeImportScratchOptions = {}): void {
  const parent = scratchParent(options)
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(OPERATION_PREFIX)) {
      const path = join(parent, entry.name)
      if (ownerIsDead(path)) {
        try {
          rmSync(path, REMOVAL)
        } catch {
          // Still charged against the quota; a later sweep retries.
        }
      }
    }
  }
}

function freeBytes(path: string): number {
  const free = statfsSync(path)
  return Number(free.bavail) * Number(free.bsize)
}

function installExitHook(): void {
  if (exitHookInstalled) {
    return
  }
  exitHookInstalled = true
  process.once('exit', () => {
    for (const release of active) {
      release()
    }
  })
}

export function createClaudeImportScratch(options: ClaudeImportScratchOptions = {}) {
  const parent = scratchParent(options)
  const quotaBytes = options.quotaBytes ?? QUOTA_BYTES
  const reserveBytes = options.reserveBytes ?? RESERVE_BYTES
  ownedParent(parent)
  sweepClaudeImportScratch({ parent })
  // Leftovers from live or unknown owners count against this import's share.
  const othersBytes = bytes(parent)
  if (othersBytes >= quotaBytes) {
    throw new ClaudeImportResourceError('Claude history import scratch quota is full.')
  }
  if (freeBytes(parent) < reserveBytes) {
    throw new ClaudeImportResourceError('Claude history import needs more free disk space.')
  }
  const root = mkdtempSync(join(parent, OPERATION_PREFIX))
  try {
    writeFileSync(join(root, 'owner'), String(process.pid), { mode: 0o600 })
  } catch (error) {
    // An ownerless folder could never be proven dead, so it must not outlive this attempt.
    rmSync(root, REMOVAL)
    throw error
  }
  let closeDatabase: (() => void) | undefined
  let closed = false
  const settle = () => {
    closed = true
    active.delete(releaseOnExit)
    try {
      closeDatabase?.()
    } catch {
      // Removal below still runs; an open file stays charged until a later sweep.
    }
  }
  const releaseOnExit = () => {
    settle()
    try {
      rmSync(root, REMOVAL)
    } catch {
      // Left for the next sweep, still charged against the quota.
    }
  }
  installExitHook()
  active.add(releaseOnExit)
  return {
    filename: join(root, 'graph.sqlite'),
    /** The database closes before its files are removed, including at process exit. */
    attach(close: () => void) {
      closeDatabase = close
    },
    /** Bytes this operation may still add before the quota or the free-space reserve. */
    allowanceBytes(): number {
      return Math.max(
        0,
        // Recounted per batch so imports sharing the folder share one quota.
        Math.min(quotaBytes - bytes(parent), freeBytes(root) - reserveBytes)
      )
    },
    async close(): Promise<void> {
      if (closed) {
        return
      }
      settle()
      try {
        await rm(root, REMOVAL)
      } catch {
        // Left for the next sweep, still charged against the quota.
      }
    }
  }
}
