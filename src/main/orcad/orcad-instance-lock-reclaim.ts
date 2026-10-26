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
// Serialize recovery so reclaimers cannot displace newly published live locks.
const RECOVERY_DIR_SUFFIX = '.recovery'
const RECOVERY_OWNER_FILE = 'owner'
const RECOVERY_RELEASED_FILE = 'released'

export type OrcadLockRecoveryOwner = {
  record: string
  exited: (ownerRecord: string) => boolean
}

/** Rename claims an exact entry; never unlink a contender’s uninspected replacement. */
export function reclaimAndPublish(
  lockPath: string,
  dataRoot: string,
  inspectedContents: string,
  publish: () => boolean,
  owner: OrcadLockRecoveryOwner
): void {
  return withRecoveryLock(lockPath, inspectedContents, owner, () => {
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
  // Do not displace a contender that replaced the inspected entry after liveness checking.
  const claimedContents = readBoundedLockFile(claimPath)
  if (claimedContents !== inspectedContents) {
    restoreDisplacedLock(claimPath, lockPath, claimedContents)
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `The orcad instance lock at ${lockPath} changed while reclaiming a stale record.`
    )
  }
  const published = publish()
  unlinkQuietly(claimPath)
  if (!published) {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `Another orcad took the data root ${dataRoot} while this one was reclaiming a stale lock.`
    )
  }
}

/** Keep old generations until every prior owner provably exits; only the newest can reclaim. */
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
    // Missing owners indicate interrupted cleanup; publication always includes a complete owner.
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
      // Retain released generations so contenders cannot confuse reused generation numbers.
      writeQuietly(join(`${prefix}${generation}`, RECOVERY_RELEASED_FILE))
    } else {
      for (const stale of recoveryGenerations(prefix)) {
        try {
          rmSync(`${prefix}${stale}`, { recursive: true, force: true })
        } catch {
          // Once the stale record is gone, late contenders are inert.
        }
      }
    }
  }
}

/** Key by inspected contents so all contenders share recovery despite intervening inode/path changes. */
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

/** Stage complete owner records; rename cannot replace an existing nonempty lock directory. */
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
    // Remove only this attempt’s staging, never an entry another attempt owns.
    rmSync(staged, { recursive: true, force: true })
    return false
  }
}

/** Restore without replacing newer authoritative contenders. */
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
      // New contenders or failed restoration require a closed result.
    }
  }
}

/** Unreadable owners cannot prove the reclaimer exited. */
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
    // If unwritable, the owner’s process exit still releases recovery.
  }
}

export function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

export function readBoundedLockFile(path: string): string | null {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, MAX_ORCAD_LOCK_BYTES)
    return stats.isFile() ? buffer.toString('utf8') : null
  } catch {
    return null
  }
}
