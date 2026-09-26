import {
  recoveryBindingKeyOf,
  type RecoveryBindingKey
} from '../../../shared/cross-machine-recovery-binding-key'
import type { CrossMachineRecoveryReleaseLocalResult } from '../../../shared/cross-machine-recovery-session-ops'
import { holdRecoveryBinding, recordConsumedRecoveryBinding } from './recovery-resume'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

/** "Start shell instead": consumes a dormant binding by explicit choice so no replay re-adds it. */
export async function releaseRecoveryBindingWithHost(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  binding: RecoveryBindingKey
): Promise<CrossMachineRecoveryReleaseLocalResult> {
  const release = holdRecoveryBinding(host, binding)
  try {
    const outcome = await host.applyOp({ kind: 'claim-record', worktreeId, binding })
    if (!outcome.ok || !outcome.claimed) {
      throw new Error('recovery_binding_not_found')
    }
    const record = outcome.claimed
    try {
      await recordConsumedRecoveryBinding(host, worktreeId, binding)
    } catch (error) {
      // Why: an unrecorded release must leave the binding dormant, not lost to both Resume and replay.
      await host.applyOp({ kind: 'restore-record', record })
      throw error
    }
    return { released: recoveryBindingKeyOf(record) }
  } finally {
    release()
  }
}
