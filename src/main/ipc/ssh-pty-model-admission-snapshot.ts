import type { SshPtyModelAdmissionDebugSnapshot } from './ssh-pty-model-admission-contract'
import type { SshPtyModelAdmissionPressure } from './ssh-pty-model-admission-pressure'

export function sshPtyModelAdmissionSnapshot(
  sourceUnits: number,
  bytes: number,
  pressure: SshPtyModelAdmissionPressure,
  migratingPtys: ReadonlySet<string>
): SshPtyModelAdmissionDebugSnapshot {
  return {
    sourceUnits,
    bytes,
    pressureFrames: pressure.frameCount,
    pressureBytes: pressure.bytes,
    pausedPtys: pressure.pausedPtyCount,
    migratingPtys: migratingPtys.size
  }
}
