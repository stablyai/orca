/** Whether an orcad lock or peer record was written on this machine, where its PID means something. */
import process from 'node:process'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { readOrcadProcessIncarnation } from './orcad-process-start-time'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import {
  orcadStaleLockReclaimCommand,
  type OrcadReclaimHintRuntime
} from '../../shared/orcad-stale-lock-reclaim'

/**
 * Same machine: the same machine identity, or (records without one) the same kernel boot. A record
 * that names neither is local only when no other machine can reach the data root.
 */
export function orcadLockHolderLocality(
  holder: OrcadPeerMachine,
  self: OrcadPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): 'local' | 'foreign' | 'unknown' {
  if (holder.machineIdentity && self.machineIdentity) {
    return holder.machineIdentity === self.machineIdentity ? 'local' : 'foreign'
  }
  if (holder.bootId && holder.bootId === self.bootId) {
    return 'local'
  }
  return dataRootIsOnLocalDisk() ? 'local' : 'unknown'
}

export type OrcadPeerMachine = { machineIdentity?: string; bootId?: string }

export function currentOrcadPeerMachine(): OrcadPeerMachine {
  const machineIdentity = profileStateAccessMachineIdentity()
  const bootId = readOrcadProcessIncarnation(process.pid)?.bootId
  return { ...(machineIdentity ? { machineIdentity } : {}), ...(bootId ? { bootId } : {}) }
}

/**
 * Whether a peer's recorded PID means anything here: same machine and kernel boot. A different or
 * unprovable one leaves the peer unverifiable, never exited.
 */
export function orcadPeerPidIsJudgeableHere(
  peer: OrcadPeerMachine,
  self: OrcadPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): boolean {
  if (peer.bootId && self.bootId && peer.bootId !== self.bootId) {
    return false
  }
  return orcadLockHolderLocality(peer, self, dataRootIsOnLocalDisk) === 'local'
}

/** A lock this machine cannot judge; on Linux it names the command that checks and clears it. */
export function orcadLockHolderUnverifiableError(lock: {
  holder: string
  foreign: boolean
  dataRoot: string
  lockPath: string
  /** An orcad names its own runtime and entry: managed hosts have no `orca` or `orcad` on PATH. */
  hintRuntime: OrcadReclaimHintRuntime | null
}): OrcadInstanceLockError {
  const command = orcadStaleLockReclaimCommand(lock.dataRoot, lock.hintRuntime)
  const reclaim =
    process.platform === 'linux'
      ? `run \`${command}\` on the machine it ran on to check and clear it, or `
      : ''
  return new OrcadInstanceLockError(
    'orcad_instance_lock_holder_unverifiable',
    `${lock.holder} holds the data root ${lock.dataRoot}${lock.foreign ? ' from another machine' : ''}. ` +
      'Orca cannot check from here whether it is still running, because this data root may be ' +
      `shared with other machines. Stop it there. If it is not running anywhere, ${reclaim}` +
      `delete ${lock.lockPath} once you are sure.`
  )
}
