import process from 'node:process'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { readOrcadProcessIncarnation } from './orcad-process-start-time'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import {
  orcadStaleLockReclaimCommand,
  type OrcadReclaimHintRuntime
} from '../../shared/orcad-stale-lock-reclaim'

/** Match machine identity, then legacy boot identity; identity-less records require local-only storage. */
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

/** PIDs require a provable machine and boot match; unknown peers are never assumed exited. */
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

export function orcadLockHolderUnverifiableError(lock: {
  holder: string
  foreign: boolean
  dataRoot: string
  lockPath: string
  /** Managed hosts may lack launchers on PATH, so name this runtime/entry in reclaim hints. */
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
