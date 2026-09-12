import type { SshPtyLegacyProjectionLedger } from './ssh-pty-legacy-projection'
import type { SshPtyModelAdmission } from './ssh-pty-model-admission'
import type { SshPtyOutputExitDeadline } from './ssh-pty-output-exit-deadline'
import type { SshPtyOutputSourceObligations } from './ssh-pty-output-source-obligations'
import type { SshPtyOutputGenerationGuard } from './ssh-pty-output-generation-guard'

export function sshPtyOutputIntakeDebugSnapshot(args: {
  admission: SshPtyModelAdmission
  projections: SshPtyLegacyProjectionLedger
  sourceObligations: SshPtyOutputSourceObligations
  generationGuard: SshPtyOutputGenerationGuard
  exitDeadline: SshPtyOutputExitDeadline
  ownershipTransferModelCheckpoints: number
}) {
  return {
    model: args.admission.getDebugSnapshot(),
    projection: args.projections.getDebugSnapshot(),
    source: args.sourceObligations.getDebugSnapshot(),
    ownershipTransferModelCheckpoints: args.ownershipTransferModelCheckpoints,
    generation: args.generationGuard.getDebugSnapshot(),
    exitBarriers: args.exitDeadline.activeBarriers
  }
}
