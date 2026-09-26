import type { RecoveryImportResult } from '../../../shared/cross-machine-recovery-descriptor'
import type { z } from 'zod'
import type { CrossMachineRecoveryImportParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import type { OrcaRuntimeService } from '../orca-runtime'

// TODO(cc-sync import lane): replace this placeholder body with the real import.
export async function importRecoveryWorkspace(
  _runtime: OrcaRuntimeService,
  _params: z.infer<typeof CrossMachineRecoveryImportParams>
): Promise<RecoveryImportResult> {
  throw new Error('recovery_unsupported')
}
