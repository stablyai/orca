import type { RecoveryResumeResult } from '../../../shared/cross-machine-recovery-descriptor'
import type { z } from 'zod'
import type { CrossMachineRecoveryResumeParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import type { OrcaRuntimeService } from '../orca-runtime'

// TODO(cc-sync import lane): replace this placeholder body with the real resume.
export async function resumeRecoveryBinding(
  _runtime: OrcaRuntimeService,
  _params: z.infer<typeof CrossMachineRecoveryResumeParams>
): Promise<RecoveryResumeResult> {
  throw new Error('recovery_unsupported')
}
