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
import {
  chmodSync,
  linkSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { getProcessStartedAtMs, startTimeMatches } from '../daemon/daemon-process-start-time'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'

export const ORCAD_LOCK_FILE_NAME = 'orcad.lock'
const MAX_ORCAD_LOCK_BYTES = 64 * 1024

export type OrcadInstanceLockCode =
  | 'orcad_data_root_unusable'
  | 'orcad_data_root_wrong_owner'
  | 'orcad_data_root_shared'
  | 'orcad_instance_lock_held'
  | 'orcad_instance_lock_foreign_identity'
  | 'orcad_instance_lock_unreadable'

export class OrcadInstanceLockError extends Error {
  constructor(
    readonly code: OrcadInstanceLockCode,
    message: string
  ) {
    super(message)
    this.name = 'OrcadInstanceLockError'
  }
}

const OrcadLockRecordSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Null where the platform cannot read it; PID alone is then the (weaker) fence. */
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** POSIX uid, or the Windows username. Compared as an opaque string. */
  identity: z.string().min(1).max(1_024),
  version: z.string().min(1).max(255),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Distinguishes our record from a replacement written after we lost the race. */
  nonce: z.string().min(1).max(255)
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

export type OrcadInstanceLockHooks = {
  identity?: () => string
  version?: () => string
  now?: () => Date
  /** Whether a PID is running. EPERM counts as alive: it proves the process exists. */
  processIsAlive?: (pid: number) => boolean
  startedAtMs?: (pid: number) => number | null
  startTimeMatches?: (pid: number, expected: number | null) => boolean
}

function defaultIdentity(): string {
  // Why uid and not the name on POSIX: two accounts can share a login name across a
  // container boundary while the uid is what the filesystem actually enforces.
  return process.platform === 'win32'
    ? (userInfo().username ?? 'unknown')
    : String(process.getuid?.() ?? 'unknown')
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrorCode(error, 'EPERM')
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
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
 * Fail closed on a data root other identities can read or write.
 *
 * Why self-heal first and refuse second: orcad stores credentials unsealed (there is no OS
 * keyring on this host), so a group- or world-accessible root is a real exposure — but if
 * we own the directory, tightening it is strictly better than refusing to start. We refuse
 * only when the permissions are not ours to fix.
 */
function assertDataRootIsPrivate(dataRoot: string): void {
  // Windows ACLs are not expressible as a POSIX mode, and `statSync().mode` there reports a
  // synthesized one. Checking it would refuse correct deployments and pass wrong ones.
  if (process.platform === 'win32') {
    return
  }
  let stats
  try {
    stats = statSync(dataRoot)
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot stat the orcad data root ${dataRoot}: ${(error as Error).message}`
    )
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_wrong_owner',
      `The orcad data root ${dataRoot} is owned by uid ${stats.uid}, not by uid ${uid} running ` +
        'this process. Give orcad its own data root (ORCA_USER_DATA) or chown this one.'
    )
  }
  if ((stats.mode & 0o077) === 0) {
    return
  }
  try {
    chmodSync(dataRoot, 0o700)
  } catch {
    // Fall through to the re-stat, which produces the actionable message.
  }
  let mode: number
  try {
    mode = statSync(dataRoot).mode
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot stat the orcad data root ${dataRoot}: ${(error as Error).message}`
    )
  }
  if ((mode & 0o077) !== 0) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_shared',
      `The orcad data root ${dataRoot} is accessible to other users (mode ` +
        `${(mode & 0o777).toString(8)}) and could not be tightened. orcad stores credentials ` +
        'there unsealed, so it refuses to start. Run `chmod 700` on it, or point ORCA_USER_DATA ' +
        'at a private directory.'
    )
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
  const isAlive = hooks.processIsAlive ?? defaultProcessIsAlive
  const readStartedAt = hooks.startedAtMs ?? getProcessStartedAtMs
  const matchesStartTime = hooks.startTimeMatches ?? startTimeMatches

  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot create the orcad data root ${dataRoot}: ${(error as Error).message}`
    )
  }
  assertDataRootIsPrivate(dataRoot)

  const lockPath = join(dataRoot, ORCAD_LOCK_FILE_NAME)
  const record: OrcadLockRecord = {
    pid: process.pid,
    startedAtMs: readStartedAt(process.pid),
    identity,
    version: (hooks.version ?? (() => process.env.ORCA_VERSION ?? 'unknown'))(),
    acquiredAt: (hooks.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID()
  }
  const serialized = JSON.stringify(record)

  const publish = (): boolean => {
    try {
      writeFileSync(lockPath, serialized, { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        return false
      }
      throw new OrcadInstanceLockError(
        'orcad_data_root_unusable',
        `Cannot write the orcad instance lock ${lockPath}: ${(error as Error).message}`
      )
    }
  }

  if (publish()) {
    return makeLock(lockPath, record)
  }

  const existing = parseOrcadInstanceLockRecord(readBoundedLockFile(lockPath) ?? '')
  if (!existing) {
    // Why fail closed: an unreadable record proves nothing about its holder having exited.
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_unreadable',
      `The orcad instance lock at ${lockPath} is unreadable, malformed, or larger than ` +
        `${MAX_ORCAD_LOCK_BYTES} bytes. Refusing to reclaim it without proof that its holder ` +
        'has exited. Stop orcad and remove the stale lock manually.'
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
  if (isAlive(existing.pid) && matchesStartTime(existing.pid, existing.startedAtMs)) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another orcad (pid ${existing.pid}, started ${existing.acquiredAt || 'unknown'}) already ` +
        `owns the data root ${dataRoot}. Stop it before starting another, or use a different ` +
        'ORCA_USER_DATA.'
    )
  }
  // Why rename-and-then-publish rather than unlink-and-write: rename claims one exact
  // directory entry, so a replacement written between our read and our write stays at the
  // canonical path and wins — we never delete a record we did not inspect.
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
  if (parseOrcadInstanceLockRecord(claimedContents ?? '')?.nonce !== existing.nonce) {
    restoreDisplacedLock(claimPath, lockPath, claimedContents)
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `The orcad instance lock at ${lockPath} changed while reclaiming a stale record.`
    )
  }
  if (!publish()) {
    // Someone else claimed it first. Their record is authoritative; ours is not.
    try {
      unlinkSync(claimPath)
    } catch {
      // A uniquely named claim is inert.
    }
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another orcad took the data root ${dataRoot} while this one was reclaiming a stale lock.`
    )
  }
  try {
    unlinkSync(claimPath)
  } catch {
    // The canonical record is authoritative; the claim is inert.
  }
  return makeLock(lockPath, record)
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
