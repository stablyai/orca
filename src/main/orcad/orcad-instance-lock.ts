/**
 * Single-instance ownership of orcad's data root, taken BEFORE the profile is loaded.
 *
 * Two orcads on one data root corrupt it quietly: both load the same profile, both write
 * the same store file, and the loser's writes disappear on the next flush. The refusal is
 * therefore a startup gate, not a warning.
 *
 * What this lock does NOT cover, and must not: the terminal daemon. The daemon is a second
 * long-lived process living under `<root>/daemon`, it deliberately outlives the orcad that
 * spawned it, and it fences its own endpoint with a PID record of its own. A lock that
 * asked "is any process using this root" would refuse every restart that a live daemon
 * makes worthwhile. This lock scopes exactly one role — who is the runtime — so releasing
 * it says nothing about the daemon, which is what makes a non-destructive restart possible.
 */
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import {
  orcadProcessStartTimeMatches,
  readOrcadProcessStartedAtMs
} from './orcad-process-start-time'
import {
  assertOrcadDataRootIsPrivate,
  OrcadInstanceLockError,
  type OrcadDataRootPrivacyHooks
} from './orcad-data-root-privacy'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'

export const ORCAD_LOCK_FILE_NAME = 'orcad.lock'
const MAX_ORCAD_LOCK_BYTES = 64 * 1024
// A writer finishes in milliseconds; a garbled record older than this has no live writer.
const GARBLED_LOCK_GRACE_MS = 10_000

export { OrcadInstanceLockError, type OrcadInstanceLockCode } from './orcad-data-root-privacy'

const OrcadLockRecordSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Null where the platform cannot read it; PID alone is then the (weaker) fence. */
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** POSIX uid, or the Windows username. Compared as an opaque string. */
  identity: z.string().min(1).max(1_024),
  version: z.string().min(1).max(255),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Distinguishes our record from a replacement written after we lost the race. */
  nonce: z.string().min(1).max(255),
  /** Absent in records orcad wrote before the desktop app shared this lock. */
  role: z.enum(['orcad', 'desktop']).optional()
})

export type OrcadLockRecord = z.infer<typeof OrcadLockRecordSchema>

/** `null` when absent, unreadable, oversized or malformed; callers must not read that as free. */
export function readOrcadInstanceLockRecord(path: string): OrcadLockRecord | null {
  return parseOrcadInstanceLockRecord(readBoundedLockFile(path) ?? '')
}

export type OrcadInstanceLock = {
  readonly path: string
  readonly record: OrcadLockRecord
  release(): void
}

export type OrcadInstanceLockHooks = OrcadDataRootPrivacyHooks & {
  identity?: () => string
  version?: () => string
  now?: () => Date
  /** Whether a PID is running. EPERM counts as alive: it proves the process exists. */
  processIsAlive?: (pid: number) => boolean
  startedAtMs?: (pid: number) => number | null
  startTimeMatches?: (pid: number, expected: number | null) => boolean
  /**
   * Who takes the profile. The desktop app takes it too, so the two refuse each other; it must
   * hold Electron's single-instance lock first, which is what lets it reclaim a desktop record.
   */
  role?: 'orcad' | 'desktop'
}

function defaultIdentity(): string {
  // Why uid and not the name on POSIX: two accounts can share a login name across a
  // container boundary while the uid is what the filesystem actually enforces.
  return process.platform === 'win32'
    ? (userInfo().username ?? 'unknown')
    : String(process.getuid?.() ?? 'unknown')
}

/** `null` for anything that is not a complete record; never a reason to treat a lock as free. */
export function parseOrcadInstanceLockRecord(content: string): OrcadLockRecord | null {
  try {
    const result = OrcadLockRecordSchema.safeParse(JSON.parse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Take the lock, or throw an `OrcadInstanceLockError` naming why.
 *
 * A dead holder's record is reclaimed; a live one, or one belonging to a different identity,
 * is never touched.
 */
export function acquireOrcadInstanceLock(
  dataRoot: string,
  hooks: OrcadInstanceLockHooks = {}
): OrcadInstanceLock {
  const identity = (hooks.identity ?? defaultIdentity)()
  const isAlive = hooks.processIsAlive ?? isProcessAlive
  const readStartedAt = hooks.startedAtMs ?? readOrcadProcessStartedAtMs
  const matchesStartTime = hooks.startTimeMatches ?? orcadProcessStartTimeMatches

  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot create the orcad data root ${dataRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  // The desktop's profile keeps the permissions it was created with; orcad tightens its own.
  if ((hooks.role ?? 'orcad') === 'orcad') {
    assertOrcadDataRootIsPrivate(dataRoot, hooks)
  }

  const lockPath = join(dataRoot, ORCAD_LOCK_FILE_NAME)
  const record: OrcadLockRecord = {
    pid: process.pid,
    startedAtMs: readStartedAt(process.pid),
    identity,
    version: (hooks.version ?? (() => process.env.ORCA_VERSION ?? 'unknown'))(),
    acquiredAt: (hooks.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID(),
    role: hooks.role ?? 'orcad'
  }
  const serialized = JSON.stringify(record)

  // Staged then hard-linked: the canonical path only ever holds a complete record, never a torn one.
  const publish = (): boolean => {
    const staged = `${lockPath}.staged-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(staged, serialized, { flag: 'wx', mode: 0o600 })
      linkSync(staged, lockPath)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return false
      }
      throw new OrcadInstanceLockError(
        'orcad_data_root_unusable',
        `Cannot write the orcad instance lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      unlinkQuietly(staged)
    }
  }

  if (publish()) {
    return makeLock(lockPath, record)
  }

  const existingContents = readBoundedLockFile(lockPath)
  if (existingContents === null) {
    // Why fail closed: a record we cannot read proves nothing about its holder having exited.
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_unreadable',
      `The orcad instance lock at ${lockPath} is unreadable or larger than ` +
        `${MAX_ORCAD_LOCK_BYTES} bytes. Refusing to reclaim it without proof that its holder ` +
        'has exited. Stop orcad and remove the stale lock manually.'
    )
  }
  const existing = parseOrcadInstanceLockRecord(existingContents)
  if (!existing) {
    // Only a torn write (an older build, or a crash mid-write) leaves this; once it has aged
    // past any live writer, no owner can be behind it.
    if (garbledLockIsAbandoned(lockPath)) {
      return reclaimAndPublish(lockPath, dataRoot, existingContents, publish, record)
    }
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `The orcad instance lock at ${lockPath} is still being written by another process. Retry.`
    )
  }
  if (existing.identity !== identity) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_foreign_identity',
      `The orcad data root ${dataRoot} is locked by identity ${existing.identity} (pid ` +
        `${existing.pid}); this process runs as ${identity}. Two identities sharing one data ` +
        'root corrupts it. Give each its own ORCA_USER_DATA.'
    )
  }
  // The desktop takes this lock only after Electron's single-instance lock, which already proves
  // no other desktop runs; a desktop record is then stale even when its PID was reused.
  const staleDesktopRecord = hooks.role === 'desktop' && existing.role === 'desktop'
  if (
    !staleDesktopRecord &&
    isAlive(existing.pid) &&
    matchesStartTime(existing.pid, existing.startedAtMs)
  ) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `${describeLockHolder(existing)} (pid ${existing.pid}, started ` +
        `${existing.acquiredAt || 'unknown'}) already owns the data root ${dataRoot}. Stop it ` +
        'before starting another, or use a different ORCA_USER_DATA.'
    )
  }
  return reclaimAndPublish(lockPath, dataRoot, existingContents, publish, record)
}

/**
 * Why rename-and-then-publish rather than unlink-and-write: rename claims one exact directory
 * entry, so a replacement written between our read and our write stays at the canonical path
 * and wins — we never delete a record we did not inspect.
 */
function reclaimAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean,
  record: OrcadLockRecord
): OrcadInstanceLock {
  const claimPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
  try {
    renameSync(lockPath, claimPath)
  } catch {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Could not reclaim the stale orcad instance lock at ${lockPath}; another process is ` +
        'holding it. Retry, or stop the other orcad.'
    )
  }
  // A contender may have replaced the entry after the liveness check; never displace its record.
  const claimedContents = readBoundedLockFile(claimPath)
  if (claimedContents !== inspectedContents) {
    restoreDisplacedLock(claimPath, lockPath, claimedContents)
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `The orcad instance lock at ${lockPath} changed while reclaiming a stale record.`
    )
  }
  const published = publish()
  // A uniquely named claim is inert either way.
  unlinkQuietly(claimPath)
  if (!published) {
    // Someone else claimed it first. Their record is authoritative; ours is not.
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another orcad took the data root ${dataRoot} while this one was reclaiming a stale lock.`
    )
  }
  return makeLock(lockPath, record)
}

function garbledLockIsAbandoned(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > GARBLED_LOCK_GRACE_MS
  } catch {
    return false
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or inert under its unique name.
  }
}

function describeLockHolder(record: OrcadLockRecord): string {
  return record.role === 'desktop' ? 'The Orca desktop app' : 'Another orcad'
}

/** No-clobber restore: a third contender's newer record at the canonical path stays authoritative. */
function restoreDisplacedLock(
  claimPath: string,
  lockPath: string,
  claimedContents: string | null
): void {
  try {
    linkSync(claimPath, lockPath)
    unlinkSync(claimPath)
  } catch {
    if (claimedContents === null) {
      return
    }
    try {
      writeFileSync(lockPath, claimedContents, { flag: 'wx', mode: 0o600 })
      unlinkSync(claimPath)
    } catch {
      // A newer contender won, or restoration is unavailable; fail closed.
    }
  }
}

function readBoundedLockFile(path: string): string | null {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, MAX_ORCAD_LOCK_BYTES)
    return stats.isFile() ? buffer.toString('utf8') : null
  } catch {
    return null
  }
}

function makeLock(lockPath: string, record: OrcadLockRecord): OrcadInstanceLock {
  let released = false
  return {
    path: lockPath,
    record,
    release: () => {
      if (released) {
        return
      }
      released = true
      // Why re-read before unlinking: a reclaim by a later orcad (after, say, a SIGKILL that
      // this process somehow survived enough to run handlers) leaves a record that is not
      // ours. Deleting it would unlock a live runtime.
      const current = parseOrcadInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
      if (!current || current.nonce !== record.nonce) {
        return
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // Best-effort: a leftover record with a dead pid is reclaimed on the next start.
      }
    }
  }
}
