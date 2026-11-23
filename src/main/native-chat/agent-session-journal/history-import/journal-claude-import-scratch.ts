import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

const RESERVE_BYTES = 512 * 1024 * 1024
const QUOTA_BYTES = 4 * 1024 * 1024 * 1024
const OPERATION_PREFIX = 'operation-'
// Each write batch is granted at most this much, so imports in other processes overshoot by little.
const GRANT_BYTES = 64 * 1024 * 1024
const RESERVED_FILE = 'reserved'
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

// An operation is charged its grant until it actually grows past it.
function charge(path: string): { bytes: number; unwritten: number } {
  let reserved = 0
  try {
    reserved = Number(readFileSync(join(path, RESERVED_FILE), 'utf8')) || 0
  } catch {
    // No grant yet.
  }
  const written = bytes(path)
  return { bytes: Math.max(written, reserved), unwritten: Math.max(0, reserved - written) }
}

/** Everything charged against the quota, and the part granted but not yet on disk. */
function chargedBytes(parent: string, except?: string): { bytes: number; unwritten: number } {
  const total = { bytes: 0, unwritten: 0 }
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const path = join(parent, entry.name)
    if (path === except) {
      continue
    }
    try {
      const charged = entry.isDirectory()
        ? charge(path)
        : { bytes: lstatSync(path).size, unwritten: 0 }
      total.bytes += charged.bytes
      total.unwritten += charged.unwritten
    } catch {
      // Removed while we counted.
    }
  }
  return total
}

// Replaced whole, so a concurrent reader never sees a truncated grant.
function recordGrant(root: string, bytes: number): void {
  const pending = join(root, `${RESERVED_FILE}.pending`)
  writeFileSync(pending, String(bytes), { mode: 0o600 })
  renameSync(pending, join(root, RESERVED_FILE))
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
  if (chargedBytes(parent).bytes >= quotaBytes) {
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
    /** Grants and records the bytes the next write batch may add, within quota and reserve. */
    grantBytes(): number {
      const own = bytes(root)
      const fits = (grant: number) => {
        const others = chargedBytes(parent, root)
        return Math.max(
          0,
          Math.min(
            grant,
            quotaBytes - others.bytes - own,
            // Free space other imports were granted but haven't written yet is already spoken for.
            freeBytes(root) - others.unwritten - reserveBytes
          )
        )
      }
      // Record, then recount, then only shrink: of two imports granting at once, the later
      // recorder sees the earlier one, so their grants never share the same space.
      const tentative = fits(GRANT_BYTES)
      recordGrant(root, own + tentative)
      const grant = fits(tentative)
      if (grant < tentative) {
        recordGrant(root, own + grant)
      }
      return grant
    },
    /** Synchronous, so a worker that answers right after cannot cut the removal short. */
    close(): void {
      if (!closed) {
        releaseOnExit()
      }
    }
  }
}
