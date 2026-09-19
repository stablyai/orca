import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import type { OrcadManagedStopRuntimeIdentity } from '../../shared/orcad-managed-stop-authority'
import type { OrcadManagedStopInstance } from '../../shared/orcad-managed-stop-instance'
import type { OrcadInstanceLock } from './orcad-instance-lock'
import { loadOrCreateRuntimeIdentity } from '../runtime/runtime-identity'
import { PtyOwnershipTransferAdmissionRecord } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-admission-record'
import { startOrcadDaemon } from './orcad-daemon-supervision'

export function captureOrcadManagedStopInstance(
  lock: OrcadInstanceLock
): Readonly<OrcadManagedStopInstance> {
  return Object.freeze({
    pid: lock.record.pid,
    startedAtMs: lock.record.startedAtMs,
    nonce: lock.record.nonce,
    lockPath: realpathSync(lock.path)
  })
}

export function captureOrcadManagedStopContext(
  runtimeId: string,
  profile: { profile: { id: string }; profileDirectory: string },
  lock: OrcadInstanceLock
) {
  return [
    captureOrcadManagedStopIdentity(runtimeId, profile),
    captureOrcadManagedStopInstance(lock)
  ] as const
}

export function captureOrcadManagedStopIdentity(
  runtimeId: string,
  profile: { profile: { id: string }; profileDirectory: string }
): Readonly<OrcadManagedStopRuntimeIdentity> {
  return Object.freeze({
    runtimeId,
    profileId: profile.profile.id,
    profileRoot: realpathSync(profile.profileDirectory)
  })
}

export async function startOrcadProfileDaemon(profileDirectory: string): Promise<string> {
  const runtimeId = loadOrCreateRuntimeIdentity(join(profileDirectory, 'runtime-identity.json'))
  const recoveryOnly = new PtyOwnershipTransferAdmissionRecord(
    profileDirectory,
    runtimeId
  ).isClosed()
  await startOrcadDaemon({ recoveryOnly })
  return runtimeId
}
