import { recoverInterruptedDecommission } from './orcad-decommission-recovery'
import {
  ensureRecordedRuntimeServing,
  recordedRuntimeIsServing,
  orcadRecoveryInstallDir as installDir,
  executeOrcadRecoveryCommand as exec
} from './orcad-recovery-slot'
import type { SshConnection } from './ssh-connection'
import {
  planOrcadActivationRecovery,
  sameOrcadActivationRecord,
  type OrcadActivationRecoveryPlan,
  type OrcadRollbackTransaction
} from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { withStaleOrcadActivationRecoveryLock } from './orcad-activation-lock'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import {
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { ORCAD_STATE_SNAPSHOT_DIR, type OrcadActivationRecord } from './orcad-activation-record'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import type { OrcadManagedDecommissionResult } from '../../shared/orcad-managed-decommission'
import type { OrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'

const STOP_WAIT_SECONDS = 20

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

export type OrcadActivationRecoveryOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  assertDecommissionAllowed?: () => void
  requestDecommission?: (
    activeVersion: string,
    transactionId: string
  ) => Promise<OrcadDecommissionResult>
  requestManagedDecommission?: (
    activeVersion: string,
    authority: OrcadManagedStopAuthority
  ) => Promise<OrcadManagedDecommissionResult>
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

export async function recoverInterruptedOrcadActivation(
  options: OrcadActivationRecoveryOptions
): Promise<OrcadActivationRecoveryResult> {
  const pending = await readOrcadActivationTransaction(options)
  if (!pending) {
    return { outcome: 'none' }
  }
  try {
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      const transaction = await readOrcadActivationTransaction(options)
      if (!transaction) {
        return { outcome: 'none' }
      }
      const currentRecord = await readOrcadActivationRecord(options)
      if (transaction.operation === 'rollback') {
        return recoverInterruptedRollback(options, transaction, currentRecord, lock)
      }
      if (transaction.operation === 'decommission') {
        options.assertDecommissionAllowed?.()
        return recoverInterruptedDecommission(options, transaction, currentRecord, lock)
      }
      const plan = planOrcadActivationRecovery(transaction, currentRecord)
      if (plan.action === 'refuse') {
        lock.retain()
        return { outcome: 'refused', verdict: 'unverifiable', ...plan }
      }
      return executeRecoveryPlan(options, plan)
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'orcad_recovery_transaction_still_fresh',
        reason:
          'The interrupted activation fence is not old enough to reclaim safely. Retry after its 20-minute recovery window.'
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

async function recoverInterruptedRollback(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadRollbackTransaction,
  currentRecord: OrcadActivationRecord,
  lock: { retain(): void }
): Promise<OrcadActivationRecoveryResult> {
  if (sameOrcadActivationRecord(currentRecord, transaction.recordAfter)) {
    if (!transaction.recordAfter.active) {
      throw new Error('The committed rollback record has no active version.')
    }
    const readiness = await ensureRecordedRuntimeServing(options, transaction.recordAfter.active)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: transaction.recordAfter.active,
      readiness
    }
  }
  if (!sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_rollback_record_changed',
      reason:
        'The activation record matches neither side of the interrupted rollback. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }

  if (
    transaction.phase === 'rescue-captured' ||
    transaction.phase === 'rollback-state-restored' ||
    transaction.phase === 'target-ready'
  ) {
    const quiescence = await quiesceCandidate(
      options,
      transaction.targetVersion,
      transaction.recordBefore
    )
    if (quiescence === 'quiescent') {
      await restoreRollbackRescueState(options, transaction)
    }
  }
  const readiness = await ensureRecordedRuntimeServing(options, transaction.incumbentVersion)
  return {
    outcome: 'recovered',
    resolution: 'restored-incumbent',
    activeVersion: transaction.incumbentVersion,
    readiness
  }
}

async function restoreRollbackRescueState(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadRollbackTransaction
): Promise<void> {
  if (transaction.rescue.state === 'pending') {
    throw new Error('The interrupted rollback has no durable rescue snapshot verdict.')
  }
  const command =
    transaction.rescue.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(
          options.host,
          options.userDataDir,
          joinRemotePath(
            options.host,
            options.remoteHome,
            RELAY_REMOTE_DIR,
            ORCAD_STATE_SNAPSHOT_DIR,
            transaction.rescue.dirName
          )
        )
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  const restored = parseOrcadSnapshotRestore(await exec(options, command))
  if (restored !== 'restored') {
    throw new Error(`The pre-rollback rescue could not be restored (${restored}).`)
  }
}

async function executeRecoveryPlan(
  options: OrcadActivationRecoveryOptions,
  plan: Exclude<OrcadActivationRecoveryPlan, { action: 'refuse' }>
): Promise<OrcadActivationRecoveryResult> {
  if (plan.action === 'stabilize-committed') {
    if (!plan.record.active) {
      throw new Error('The committed activation record has no active version.')
    }
    const readiness = await ensureRecordedRuntimeServing(options, plan.record.active)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: plan.record.active,
      readiness
    }
  }

  if (plan.restoreSnapshot) {
    const quiescence = await quiesceCandidate(options, plan.candidateVersion, plan.record)
    if (quiescence === 'quiescent') {
      await restorePreActivationState(options, plan.snapshot)
    }
  }
  const readiness = plan.record.active
    ? await ensureRecordedRuntimeServing(options, plan.record.active)
    : null
  return {
    outcome: 'recovered',
    resolution: 'restored-incumbent',
    activeVersion: plan.record.active,
    readiness
  }
}

async function quiesceCandidate(
  options: OrcadActivationRecoveryOptions,
  candidateVersion: string,
  recordBefore: OrcadActivationRecord
): Promise<'quiescent' | 'incumbent-live'> {
  const candidateDir = installDir(options, candidateVersion)
  const stopped = parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, candidateDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
  if (orcadStopFreedTheHost(stopped)) {
    return 'quiescent'
  }
  if (stopped === 'no-pid') {
    if (recordBefore.active && (await recordedRuntimeIsServing(options, recordBefore.active))) {
      return 'incumbent-live'
    }
    const admission = parseInitialOrcadActivationAdmission(
      await exec(
        options,
        initialOrcadActivationAdmissionCommand(options.host, options.userDataDir, candidateDir)
      )
    )
    if (admission.decision === 'proceed') {
      return 'quiescent'
    }
  }
  throw new Error(
    `The candidate ${candidateVersion} could not be confirmed stopped (${stopped}); ` +
      'state restoration would be unsafe.'
  )
}

async function restorePreActivationState(
  options: OrcadActivationRecoveryOptions,
  snapshot: { dirName: string; state: 'pending' | 'captured' | 'empty' }
): Promise<void> {
  if (snapshot.state === 'pending') {
    throw new Error('The interrupted activation has no durable snapshot verdict.')
  }
  const command =
    snapshot.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(
          options.host,
          options.userDataDir,
          joinRemotePath(
            options.host,
            options.remoteHome,
            RELAY_REMOTE_DIR,
            ORCAD_STATE_SNAPSHOT_DIR,
            snapshot.dirName
          )
        )
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  const restored = parseOrcadSnapshotRestore(await exec(options, command))
  if (restored !== 'restored') {
    throw new Error(`The pre-activation state could not be restored (${restored}).`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
