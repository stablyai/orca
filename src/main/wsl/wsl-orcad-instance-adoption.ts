/** Adopt serving unrecorded orcad under the activation fence only when lock, readiness and installed build identify the same process. Never kill it without census; launching another loses the instance lock. Normal update admission handles version changes. */
import {
  ORCAD_LOCK_FILE_NAME,
  parseOrcadInstanceLockRecord,
  type OrcadLockRecord
} from '../orcad/orcad-instance-lock'
import { compareOrcadProcessIdentity } from '../orcad/orcad-process-start-time'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record-store'
import { evaluateOrcadActivation } from '../managed-server/activation/orcad-activation-gate'
import { withOrcadActivationLock } from '../managed-server/activation/orcad-activation-lock'
import { sameOrcadActivationRecord } from '../managed-server/activation/orcad-activation-transaction'
import { readOrcadActivationTransaction } from '../managed-server/activation/orcad-activation-transaction-store'
import { readRemoteOrcadManagedStopTarget } from '../managed-server/lifecycle/orcad-managed-remote-stop'
import {
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from '../ssh/orcad-recovery-slot'
import { ORCAD_PID_FILENAME } from '../managed-server/install/orcad-remote-host-support'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from '../managed-server/install/orcad-remote-readiness-wait'
import { readBoundedOrcadRemoteRecord } from '../managed-server/install/orcad-remote-record-file'
import { execOrcadRemote } from '../managed-server/install/orcad-remote-runtime-control'
import {
  ORCAD_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallVersionDirRegex
} from '../managed-server/install/remote-install-model'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { readWslGuestIdentity, wslGuestOrcadIncarnation } from './wsl-guest-process-identity'
import type { WslOrcadInstanceLockRead } from './wsl-orcad-connect-state-snapshot'

const LOCK_RECORD_MAX_BYTES = 64 * 1024
const UNRECORDED_ORCAD_CODE = 'wsl_orcad_unrecorded_instance_unverifiable'

export type WslOrcadAdoption =
  | { outcome: 'none' }
  | { outcome: 'adopted'; version: string; pid: number; record: OrcadActivationRecord }

export class WslOrcadUnrecordedInstanceError extends Error {
  readonly code = UNRECORDED_ORCAD_CODE
  constructor(message: string) {
    super(message)
    this.name = 'WslOrcadUnrecordedInstanceError'
  }
}

type LockHolder = { pid: number; version: string }

async function readLiveLockHolder(
  slot: OrcadSlotOptions,
  preRead?: WslOrcadInstanceLockRead
): Promise<LockHolder | null> {
  const lockPath = joinRemotePath(slot.host, slot.userDataDir, ORCAD_LOCK_FILE_NAME)
  const read =
    preRead ?? (await readBoundedOrcadRemoteRecord(slot, lockPath, LOCK_RECORD_MAX_BYTES))
  const lock = read.state === 'present' ? parseOrcadInstanceLockRecord(read.raw) : null
  // Desktop-role or malformed locks identify no orcad to adopt.
  if (!lock || lock.role === 'desktop') {
    return null
  }
  // Adopt only proven-live holders; otherwise let the host's instance lock arbitrate launch.
  return (await lockHolderLiveness(slot, lock)) === 'live'
    ? { pid: lock.pid, version: lock.version }
    : null
}

type LockHolderLiveness = 'live' | 'unverifiable' | 'exited'

/** A PID is no identity after a distro restart reuses it: the lock's boot id and start ticks are. */
async function lockHolderLiveness(
  slot: OrcadSlotOptions,
  lock: OrcadLockRecord
): Promise<LockHolderLiveness> {
  const guest = await readWslGuestIdentity(slot.conn, lock.pid)
  if (!guest) {
    return 'unverifiable'
  }
  const incarnation = wslGuestOrcadIncarnation(guest)
  // The guest answered, and no process has that PID.
  if (!incarnation) {
    return 'exited'
  }
  // Compare boot IDs case-insensitively because readers normalize them.
  const recorded = lock.bootId ? { ...lock, bootId: lock.bootId.toLowerCase() } : lock
  const verdict = compareOrcadProcessIdentity(lock.pid, recorded, {
    incarnation: () => incarnation,
    // Ignore wall-clock starts: guest clocks jump after host sleep.
    startedAtMs: () => null,
    platform: 'linux'
  })
  return verdict === 'matches' ? 'live' : verdict === 'differs' ? 'exited' : 'unverifiable'
}

async function readSlotPid(slot: OrcadSlotOptions, version: string): Promise<number | null> {
  const pidFile = joinRemotePath(slot.host, orcadSlotDir(slot, version), ORCAD_PID_FILENAME)
  const raw = await execOrcadRemote(slot, `cat ${quotePosixShell(pidFile)} 2>/dev/null || true`)
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** The holder's slot must publish readiness for this pid, from the build installed there. */
async function proveHolderServesItsSlot(slot: OrcadSlotOptions, holder: LockHolder): Promise<void> {
  const label = `An orcad (pid ${holder.pid}, ${holder.version}) is running in this distro but is not the recorded one`
  const dirName = remoteInstallDirName(ORCAD_INSTALL_MODEL, holder.version)
  if (!remoteInstallVersionDirRegex(ORCAD_INSTALL_MODEL).test(dirName)) {
    throw new WslOrcadUnrecordedInstanceError(`${label}, and its version is not a slot name.`)
  }
  const target = await readRemoteOrcadManagedStopTarget(slot, holder.version)
  if (target.state !== 'ready' || target.context.instance.pid !== holder.pid) {
    throw new WslOrcadUnrecordedInstanceError(
      `${label}, and it cannot be identified: ${target.state === 'refused' ? target.reason : 'its readiness names another process.'}`
    )
  }
  const identity = await resolveOrcadSlotIdentity(slot, holder.version)
  const readiness = parseOrcadReadinessWaitOutput(
    slot.host,
    await execOrcadRemote(slot, readOrcadReadinessNowCommand(slot.host, identity.remoteDir))
  )
  const verdict = evaluateOrcadActivation(
    readiness.state === 'ready' ? readiness.readiness : null,
    {
      buildHash: identity.buildHash,
      fullVersion: identity.version
    }
  )
  if (verdict.decision === 'reject') {
    throw new WslOrcadUnrecordedInstanceError(`${label}, and ${verdict.reason}`)
  }
}

function adoptedRecord(
  record: OrcadActivationRecord,
  version: string,
  now: Date
): OrcadActivationRecord {
  if (record.active === version) {
    return record
  }
  const { activeAppVersion, previousAppVersion: _previousAppVersion, ...rest } = record
  return {
    ...rest,
    active: version,
    previous: record.active ?? record.previous,
    ...(record.active && activeAppVersion ? { previousAppVersion: activeAppVersion } : {}),
    activatedAt: now.toISOString(),
    // Prelaunch snapshot belongs to another activation; rollback must not restore it.
    snapshot: null
  }
}

/** Adopt lock owners missing from record/pid file only with proof; otherwise refuse rather than launch into an occupied instance lock. */
export async function adoptUnrecordedWslOrcad(
  slot: OrcadSlotOptions,
  record: OrcadActivationRecord,
  now: () => Date = () => new Date(),
  /** This connect's snapshot of the lock; the fenced re-check below always reads the host. */
  preReadLock?: WslOrcadInstanceLockRead
): Promise<WslOrcadAdoption> {
  const holder = await readLiveLockHolder(slot, preReadLock)
  if (!holder) {
    return { outcome: 'none' }
  }
  if (
    record.active === holder.version &&
    (await readSlotPid(slot, holder.version)) === holder.pid
  ) {
    return { outcome: 'none' }
  }
  await proveHolderServesItsSlot(slot, holder)
  return withOrcadActivationLock(
    slot,
    async () => {
      const current = await readOrcadActivationRecord(slot)
      if (!sameOrcadActivationRecord(current, record)) {
        throw new WslOrcadUnrecordedInstanceError(
          'The activation record changed while an unrecorded orcad was being adopted. Retry.'
        )
      }
      if (await readOrcadActivationTransaction(slot)) {
        throw new WslOrcadUnrecordedInstanceError(
          'An interrupted activation is pending, so an unrecorded orcad cannot be adopted yet.'
        )
      }
      const again = await readLiveLockHolder(slot)
      if (again?.pid !== holder.pid || again.version !== holder.version) {
        throw new WslOrcadUnrecordedInstanceError(
          'The unrecorded orcad changed while it was being adopted. Retry.'
        )
      }
      const pidFile = joinRemotePath(
        slot.host,
        orcadSlotDir(slot, holder.version),
        ORCAD_PID_FILENAME
      )
      await execOrcadRemote(
        slot,
        `(umask 077 && printf '%s\\n' ${String(holder.pid)} > ${quotePosixShell(pidFile)})`
      )
      const next = adoptedRecord(current, holder.version, now())
      if (next !== current) {
        await writeOrcadActivationRecord(slot, next)
      }
      return {
        outcome: 'adopted' as const,
        version: holder.version,
        pid: holder.pid,
        record: next
      }
    },
    () => {
      throw new WslOrcadUnrecordedInstanceError(
        'Another Orca is changing this distro’s server, so an unrecorded orcad cannot be adopted now.'
      )
    }
  )
}
