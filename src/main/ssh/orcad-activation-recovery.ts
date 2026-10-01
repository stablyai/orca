/**
 * Finishing or undoing an activation, rollback or decommission that a crash, a lost connection or an
 * unverifiable failure left fenced. Either way the host ends serving exactly the slot its
 * activation record names, or the fence stays for an operator.
 */
import type { ServeReadiness } from '../server/serve-readiness'
import {
  planOrcadTransactionRecovery,
  type OrcadActivationTransaction
} from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import {
  orcadActivationFenceExists,
  withStaleOrcadActivationRecoveryLock
} from './orcad-activation-lock'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import { ensureOrcadSlotServing, resolveOrcadSlotIdentity } from './orcad-recovery-slot'
import { reconcileOrcadDecommission } from './orcad-decommission-recovery'
import {
  recoverOrcadIncumbent,
  type OrcadIncumbentRecoveryOptions
} from './orcad-incumbent-recovery'

export type OrcadActivationRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      readiness: ServeReadiness | null
    }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export type OrcadActivationRecoveryOptions = OrcadIncumbentRecoveryOptions

export async function recoverInterruptedOrcadActivation(
  options: OrcadActivationRecoveryOptions
): Promise<OrcadActivationRecoveryResult> {
  try {
    if (
      !(await readOrcadActivationTransaction(options)) &&
      !(await orcadActivationFenceExists(options))
    ) {
      return { outcome: 'none' }
    }
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      const transaction = await readOrcadActivationTransaction(options)
      if (!transaction) {
        // A release cut short after removing the journal; dropping the lock finishes it.
        return { outcome: 'none' }
      }
      const result = await reconcileOrcadTransaction(options, transaction)
      if (result.outcome !== 'recovered') {
        lock.retain()
      }
      return result
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'orcad_recovery_transaction_still_fresh',
        reason:
          'The activation fence is held by a run that may still be working. Retry after the ' +
          'install lock recovery window.'
      }
    }
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_unverifiable',
      reason:
        `The interrupted activation could not be reconciled safely: ${errorMessage(error)} ` +
        'The host remains fenced.'
    }
  }
}

/** Runs under a held fence. Throws when a step is unverifiable. */
export async function reconcileOrcadTransaction(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadActivationTransaction
): Promise<OrcadActivationRecoveryResult> {
  const plan = planOrcadTransactionRecovery(transaction, await readOrcadActivationRecord(options))
  if (plan.action === 'refuse') {
    return { outcome: 'refused', verdict: 'unverifiable', code: plan.code, reason: plan.reason }
  }
  if (
    plan.action === 'confirm-decommissioned' ||
    plan.action === 'resume-stop' ||
    plan.action === 'keep-serving'
  ) {
    return reconcileOrcadDecommission(options, plan)
  }
  if (plan.action === 'finish-commit') {
    await writeOrcadActivationRecord(options, plan.record)
  }
  if (plan.action === 'stabilize-committed' || plan.action === 'finish-commit') {
    const activeVersion = plan.action === 'finish-commit' ? plan.record.active : plan.activeVersion
    if (!activeVersion) {
      throw new Error('The committed activation record has no active version.')
    }
    const identity = await resolveOrcadSlotIdentity(options, activeVersion)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion,
      readiness: await ensureOrcadSlotServing(options, identity)
    }
  }
  const recovery = await recoverOrcadIncumbent(options, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: plan.launchedVersion,
    incumbent: plan.activeVersion
      ? await resolveOrcadSlotIdentity(options, plan.activeVersion)
      : null,
    restoreState: plan.restoreState
  })
  return recovery.outcome === 'refused'
    ? recovery
    : {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: plan.activeVersion,
        readiness: recovery.readiness
      }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
