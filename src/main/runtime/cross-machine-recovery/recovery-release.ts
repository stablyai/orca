import {
  recoveryBindingKeyOf,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'
import type { CrossMachineRecoveryReleaseLocalResult } from '../../../shared/cross-machine-recovery-session-ops'
import { claimRecoveryRecord, recordConsumedRecoveryBinding } from './recovery-resume'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

/** "Start shell instead": consumes a dormant binding by explicit choice so no replay re-adds it. */
export async function releaseRecoveryBindingWithHost(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  binding: RecoveryBindingKey
): Promise<CrossMachineRecoveryReleaseLocalResult> {
  // Why: held before the claim so a concurrent replay never re-adds the record being released.
  const release = host.resumeHolds.hold(binding)
  try {
    const record = await claimRecoveryRecord(host, worktreeId, binding)
    await recordConsumedRecoveryBinding(host, worktreeId, binding)
    return { released: recoveryBindingKeyOf(record) }
  } finally {
    release()
  }
}
