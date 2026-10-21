/**
 * Replacing a stale orcad instance lock without ever displacing a live one (see
 * `orcad-instance-lock.ts`).
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export const MAX_ORCAD_LOCK_BYTES = 64 * 1024
// Serializes stale-lock recovery, so no reclaimer ever renames away a lock another just published.
const RECOVERY_DIR_SUFFIX = '.recovery'
const RECOVERY_OWNER_FILE = 'owner'
const RECOVERY_RELEASED_FILE = 'released'

/** Who is recovering, as a lock record, and whether a recovery owner's holder provably exited. */
export type OrcadLockRecoveryOwner = {
  record: string
  exited: (ownerRecord: string) => boolean
}

/**
 * Why rename-and-then-publish rather than unlink-and-write: rename claims one exact directory
 * entry, so a replacement written between our read and our write stays at the canonical path
 * and wins — we never delete a record we did not inspect.
 */
export function reclaimAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean,
  owner: OrcadLockRecoveryOwner
): void {
  return withRecoveryLock(lockPath, inspectedContents, owner, () => {
    // Another reclaimer finished first: whatever it published is authoritative, not stale.
    if (readBoundedLockFile(lockPath) !== inspectedContents) {
      throw new OrcadInstanceLockError(
        'orcad_instance_lock_held',
        `Another process took the data root ${dataRoot} while this one was reclaiming a stale lock.`
      )
    }
    renameAndPublish(lockPath, dataRoot, inspectedContents, publish)
  })
}

function renameAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean
): void {
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
}

/**
 * One recovery lock per stale record (named by its contents), in generations: a dead
 * owner's generation is never removed or renamed, the next one is created beside it. Taking one is
 * exclusive, and a later generation exists only once every earlier owner provably exited, so the
 * newest generation's owner is the only live reclaimer and no live owner is ever displaced.
 */
function withRecoveryLock<T>(
  lockPath: string,
  inspectedContents: string,
  owner: OrcadLockRecoveryOwner,
  recover: () => T
): T {
  const prefix = orcadLockRecoveryPrefix(lockPath, inspectedContents)
  const generations = recoveryGenerations(prefix)
  const newest = generations.at(-1)
  const newestDir = `${prefix}${newest}`
  const newestOwner = newest === undefined ? null : readRecoveryOwner(newestDir)
  const free =
    newestOwner === null ||
    // A generation is never published without its owner; one without is a cut-short cleanup's.
    newestOwner.state === 'absent' ||
    (newestOwner.state === 'present' &&
      (existsSync(join(newestDir, RECOVERY_RELEASED_FILE)) || owner.exited(newestOwner.record)))
  const generation = newest === undefined ? 0 : newest + 1
  if (!free || !takeRecoveryLock(`${prefix}${generation}`, owner.record)) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another process is reclaiming the stale orcad instance lock at ${lockPath}. Retry.`
    )
  }
  try {
    return recover()
  } finally {
    const current = readBoundedLockFile(lockPath)
    if (current === null || current === inspectedContents) {
      // Kept, marked released: a reused generation number could be judged by a contender that
      // read this generation's owner before we let go.
      writeQuietly(join(`${prefix}${generation}`, RECOVERY_RELEASED_FILE))
    } else {
      // Once the stale record is gone no reclaimer can use its recovery locks again.
      for (const stale of recoveryGenerations(prefix)) {
        try {
          rmSync(`${prefix}${stale}`, { recursive: true, force: true })
        } catch {
          // A late contender writing into it; it is inert once the stale record is gone.
        }
      }
    }
  }
}

/**
 * Keyed by contents alone: everyone who inspected the same stale record must share one recovery
 * lock, whatever the path held when they looked again (another inode, or nothing mid-reclaim).
 */
export function orcadLockRecoveryPrefix(lockPath: string, inspectedContents: string): string {
  const key = createHash('sha256').update(inspectedContents).digest('hex')
  return `${lockPath}${RECOVERY_DIR_SUFFIX}-${key.slice(0, 16)}-`
}

function recoveryGenerations(prefix: string): number[] {
  const name = basename(prefix)
  try {
    return readdirSync(dirname(prefix))
      .filter((entry) => entry.startsWith(name) && /^\d{1,9}$/u.test(entry.slice(name.length)))
      .map((entry) => Number(entry.slice(name.length)))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * Staged with its owner, then renamed into place: a recovery lock never exists without a complete
 * owner, and a rename onto one that does (a non-empty directory) fails instead of replacing it.
 */
function takeRecoveryLock(dir: string, ownerRecord: string): boolean {
  const staged = `${dir}.staged-${process.pid}-${randomUUID()}`
  try {
    mkdirSync(staged, { mode: 0o700 })
    writeFileSync(join(staged, RECOVERY_OWNER_FILE), ownerRecord, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw new OrcadInstanceLockError(
      'orcad_data_root_unusable',
      `Cannot create ${staged}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    renameSync(staged, dir)
    return true
  } catch {
    // Whatever holds the name, it was not created by this attempt; only our staging is removed.
    rmSync(staged, { recursive: true, force: true })
    return false
  }
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

/** An unreadable owner fails closed: it proves nothing about whether its reclaimer exited. */
function readRecoveryOwner(
  dir: string
): { state: 'absent' } | { state: 'present'; record: string } | { state: 'unreadable' } {
  const path = join(dir, RECOVERY_OWNER_FILE)
  try {
    lstatSync(path)
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? { state: 'absent' } : { state: 'unreadable' }
  }
  const record = readBoundedLockFile(path)
  return record === null ? { state: 'unreadable' } : { state: 'present', record }
}

function writeQuietly(path: string): void {
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  } catch {
    // Unwritable: the owner record still releases it once this process exits.
  }
}

export function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or inert under its unique name.
  }
}

export function readBoundedLockFile(path: string): string | null {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, MAX_ORCAD_LOCK_BYTES)
    return stats.isFile() ? buffer.toString('utf8') : null
  } catch {
    return null
  }
}
