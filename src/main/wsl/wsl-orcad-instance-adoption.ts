/**
 * An orcad still serving in a distro that its activation record does not name (a Remove that
 * failed partway, say) is adopted, never killed: only it holds the data root's instance lock, so
 * launching the recorded slot would fail, and stopping it would need a terminal census C4 has no
 * channel to take. Adoption is proven first: the instance lock, the slot's readiness and the slot's
 * installed build must all name the same process. Then the record and pid file are rewritten under
 * the activation fence. A different version is then handled by the usual update gate.
 */
import { ORCAD_LOCK_FILE_NAME, parseOrcadInstanceLockRecord } from '../orcad/orcad-instance-lock'
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

async function readLiveLockHolder(slot: OrcadSlotOptions): Promise<LockHolder | null> {
  const lockPath = joinRemotePath(slot.host, slot.userDataDir, ORCAD_LOCK_FILE_NAME)
  const read = await readBoundedOrcadRemoteRecord(slot, lockPath, LOCK_RECORD_MAX_BYTES)
  const lock = read.state === 'present' ? parseOrcadInstanceLockRecord(read.raw) : null
  // A desktop holder is not an orcad; an absent or garbled lock names nobody to adopt.
  if (!lock || lock.role === 'desktop') {
    return null
  }
  const alive = await execOrcadRemote(
    slot,
    `if kill -0 ${String(lock.pid)} 2>/dev/null; then echo LIVE; else echo DEAD; fi`
  )
  return alive.trim().split('\n').pop() === 'LIVE' ? { pid: lock.pid, version: lock.version } : null
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
    // Its prelaunch snapshot belonged to another activation; rollback must not restore it here.
    snapshot: null
  }
}

/**
 * Adopts the orcad holding the instance lock when the record or its slot's pid file does not
 * name it. Anything unprovable refuses: a launch would only lose the instance lock to it.
 */
export async function adoptUnrecordedWslOrcad(
  slot: OrcadSlotOptions,
  record: OrcadActivationRecord,
  now: () => Date = () => new Date()
): Promise<WslOrcadAdoption> {
  const holder = await readLiveLockHolder(slot)
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
