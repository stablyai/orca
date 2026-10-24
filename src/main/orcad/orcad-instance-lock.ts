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
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import {
  compareOrcadProcessIdentity,
  readOrcadProcessIncarnation,
  readOrcadProcessName,
  readOrcadProcessStartedAtMs,
  type OrcadProcessIdentityVerdict,
  type OrcadProcessIncarnation
} from './orcad-process-start-time'
import {
  assertOrcadDataRootIsPrivate,
  OrcadInstanceLockError,
  type OrcadDataRootPrivacyHooks
} from './orcad-data-root-privacy'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { orcadDataRootIsOnLocalDisk } from './orcad-data-root-locality'
import type { OrcadReclaimHintRuntime } from '../../shared/orcad-stale-lock-reclaim'
import {
  orcadLockHolderLocality,
  orcadLockHolderUnverifiableError
} from './orcad-lock-holder-locality'
import {
  MAX_ORCAD_LOCK_BYTES,
  readBoundedLockFile,
  reclaimAndPublish,
  unlinkQuietly,
  type OrcadLockRecoveryOwner
} from './orcad-instance-lock-reclaim'

export const ORCAD_LOCK_FILE_NAME = 'orcad.lock'
// A writer finishes in milliseconds; a garbled record older than this has no live writer.
const GARBLED_LOCK_GRACE_MS = 10_000

const OrcadLockRecordSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Null where the platform cannot read it; PID alone is then the (weaker) fence. */
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /**
   * Linux only, absent from older writers: drift-free identity preferred over `startedAtMs`.
   * Salvaged rather than refused, so a future encoding never makes the whole lock unreadable.
   */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  /** POSIX uid, or the Windows username. Compared as an opaque string. */
  identity: z.string().min(1).max(1_024),
  version: z.string().min(1).max(255),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Distinguishes our record from a replacement written after we lost the race. */
  nonce: z.string().min(1).max(255),
  /** Absent in records orcad wrote before the desktop app shared this lock. */
  role: z.enum(['orcad', 'desktop']).optional(),
  /**
   * The holder's machine (as profile-state owners record it). Absent from older writers. A PID is
   * evidence only on the machine that issued it, and a shared home can put two on one data root.
   */
  machineIdentity: z.string().min(1).max(255).optional().catch(undefined),
  /** The holder's hostname, absent from older writers; evidence for `--reclaim-stale-lock`. */
  host: z.string().min(1).max(255).optional().catch(undefined)
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
  incarnation?: (pid: number) => OrcadProcessIncarnation | null
  ownerUid?: (pid: number) => number | null
  processName?: (pid: number) => string | null
  /** Only `differs` frees a live holder's PID; anything less proves nothing. */
  holderIdentity?: (record: OrcadLockRecord) => OrcadProcessIdentityVerdict
  /**
   * Who takes the profile. The desktop app takes it too, so the two refuse each other; it must
   * hold Electron's single-instance lock first, which is what lets it reclaim a desktop record.
   */
  role?: 'orcad' | 'desktop'
  machineIdentity?: () => string | null
  /** Whether no other machine can reach the data root, for records that name no machine. */
  dataRootIsOnLocalDisk?: (dataRoot: string) => boolean
  /**
   * `--reclaim-stale-lock` only: the user confirmed this unverifiable record (the lock's holder, or
   * an earlier reclaimer cut short) is stale. Its PID is then judged as this machine's.
   */
  reclaimConfirmed?: (record: OrcadLockRecord, role: 'holder' | 'recovery-owner') => boolean
  /** The program a refusal names; defaults to this orcad's own runtime, or `orca serve`. */
  reclaimHintRuntime?: OrcadReclaimHintRuntime | null
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
  const readIncarnation = hooks.incarnation ?? readOrcadProcessIncarnation
  const holderIdentity =
    hooks.holderIdentity ??
    ((holder: OrcadLockRecord) =>
      compareOrcadProcessIdentity(holder.pid, holder, {
        startedAtMs: readStartedAt,
        incarnation: readIncarnation,
        ownerUid: hooks.ownerUid,
        platform: hooks.platform
      }))

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
  const machineIdentity = (hooks.machineIdentity ?? profileStateAccessMachineIdentity)()
  const record: OrcadLockRecord = {
    pid: process.pid,
    startedAtMs: readStartedAt(process.pid),
    ...readIncarnation(process.pid),
    identity,
    version: (hooks.version ?? (() => process.env.ORCA_VERSION ?? 'unknown'))(),
    acquiredAt: (hooks.now ?? (() => new Date()))().toISOString(),
    nonce: randomUUID(),
    role: hooks.role ?? 'orcad',
    ...(machineIdentity ? { machineIdentity } : {}),
    host: hostname()
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

  const dataRootIsLocal = (): boolean =>
    (hooks.dataRootIsOnLocalDisk ?? orcadDataRootIsOnLocalDisk)(dataRoot)
  const judgedHere = (holder: OrcadLockRecord, role: 'holder' | 'recovery-owner'): boolean => {
    const locality = orcadLockHolderLocality(holder, record, dataRootIsLocal)
    return (
      locality === 'local' || (locality === 'unknown' && !!hooks.reclaimConfirmed?.(holder, role))
    )
  }
  // A recovery lock is ours by the same record, and broken only on the same proof of exit.
  const recoveryOwner: OrcadLockRecoveryOwner = {
    record: serialized,
    exited: (ownerRecord) => {
      const owner = parseOrcadInstanceLockRecord(ownerRecord)
      return Boolean(
        owner &&
        owner.identity === identity &&
        judgedHere(owner, 'recovery-owner') &&
        (!isAlive(owner.pid) || holderIdentity(owner) === 'differs')
      )
    }
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
      reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
      return makeLock(lockPath, record)
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
  if (!judgedHere(existing, 'holder')) {
    // Its PID means nothing here, so neither a missing nor a reused one proves it exited.
    throw orcadLockHolderUnverifiableError({
      holder: `${describeLockHolder(existing)} (pid ${existing.pid}, started ${existing.acquiredAt})`,
      foreign: orcadLockHolderLocality(existing, record, dataRootIsLocal) === 'foreign',
      dataRoot,
      lockPath,
      hintRuntime:
        hooks.reclaimHintRuntime !== undefined
          ? hooks.reclaimHintRuntime
          : hooks.role === 'desktop'
            ? null
            : { execPath: process.execPath, entry: process.argv[1] }
    })
  }
  // The desktop takes this lock only after Electron's single-instance lock, which already proves
  // no other desktop runs; a desktop record is then stale even when its PID was reused.
  const staleDesktopRecord = hooks.role === 'desktop' && existing.role === 'desktop'
  const verdict = staleDesktopRecord || !isAlive(existing.pid) ? null : holderIdentity(existing)
  if (verdict === 'unproven' && !existing.bootId) {
    throw possiblyReusedPidError(lockPath, existing, hooks.processName ?? readOrcadProcessName)
  }
  if (verdict !== null && verdict !== 'differs') {
    throw new OrcadInstanceLockError(
      'orcad_instance_lock_held',
      `${describeLockHolder(existing)} (pid ${existing.pid}, started ` +
        `${existing.acquiredAt || 'unknown'}) already owns the data root ${dataRoot}. Stop it ` +
        'before starting another, or use a different ORCA_USER_DATA.'
    )
  }
  reclaimAndPublish(lockPath, dataRoot, existingContents, publish, recoveryOwner)
  return makeLock(lockPath, record)
}

/** A record without a boot id cannot tell its holder from a reused PID; say so. */
function possiblyReusedPidError(
  lockPath: string,
  existing: OrcadLockRecord,
  processName: (pid: number) => string | null
): OrcadInstanceLockError {
  const name = processName(existing.pid)
  const holder = existing.role === 'desktop' ? 'the Orca desktop app' : 'orcad'
  return new OrcadInstanceLockError(
    'orcad_instance_lock_held',
    `The orcad instance lock at ${lockPath} names pid ${existing.pid}, which is still running ` +
      `(as ${name ? `"${name}"` : 'an unknown program'}). This lock, written by ${holder} at ` +
      `${existing.acquiredAt}, does not record which boot it came from, so Orca cannot tell ` +
      `whether that process is still ${holder} or an unrelated program that reused the PID. ` +
      `If you are sure ${holder} is not running for this data root, delete ${lockPath} and ` +
      'try again, or use a different ORCA_USER_DATA.'
  )
}

function garbledLockIsAbandoned(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > GARBLED_LOCK_GRACE_MS
  } catch {
    return false
  }
}

function describeLockHolder(record: OrcadLockRecord): string {
  return record.role === 'desktop' ? 'The Orca desktop app' : 'Another orcad'
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
