/** The locked, journaled half of `rollbackOrcad`. */
import { orcadRemoteBaseDir } from '../install/orcad-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { OrcadRollbackOptions, OrcadRollbackResult } from '../install/orcad-remote-rollback'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { withRolledBackVersion } from '../activation/orcad-activation-record'
import { writeOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { launchAndJudgeOrcadSlot } from '../../ssh/orcad-candidate-launch-verdict'
import { assessOrcadRollback } from '../../ssh/orcad-update-plan'
import { ORCAD_LOG_FILENAME } from '../install/orcad-remote-host-support'
import {
  captureOrcadStateSnapshotCommand,
  orcadRollbackRescueDirName,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from '../host-state/orcad-state-snapshot'
import {
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds
} from '../host-state/orcad-state-newest-mtime'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import type { OrcadActivationLockControl } from '../activation/orcad-activation-lock'
import {
  rollbackStartingState,
  type OrcadRollbackTransaction
} from '../activation/orcad-activation-transaction'
import {
  createOrcadRollbackTransaction,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue
} from '../activation/orcad-activation-transaction-transitions'
import { writeOrcadActivationTransaction } from '../activation/orcad-activation-transaction-store'
import { ROLLBACK_STALE_COUNT, rollbackRecountRefusal } from './orcad-rollback-admission'
import { runFencedStop } from '../../ssh/orcad-fenced-stop'
import { execOrcadRemoteOr, withoutAbortSignal } from '../install/orcad-remote-runtime-control'
import { execOrcadStateMutationOr } from '../host-state/orcad-state-mutation-exec'
import {
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotIdentity
} from '../../ssh/orcad-recovery-slot'
import { orcadSnapshotPath } from '../../ssh/orcad-incumbent-recovery'
import {
  putTransactionIncumbentBack,
  restoreAfterRejectedCandidate
} from '../../ssh/orcad-transaction-incumbent'
import {
  readOrcadRollbackBarrierTarget,
  rollbackBarrierRefusal,
  stopIncumbentBehindTerminalBarrier
} from './orcad-rollback-terminal-barrier'
import { withOrcadLogTail } from '../install/orcad-remote-log-tail'
import { errorMessage } from '../../../shared/error-message'

async function stateWritesSinceActivation(options: OrcadRollbackOptions): Promise<boolean | null> {
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt ?? '') / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await execOrcadRemoteOr(
      options,
      newestStateMtimeCommand(
        options.host,
        options.userDataDir,
        orcadRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackOrcadLocked(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl
): Promise<OrcadRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshot = options.record.snapshot
  const presence = snapshot
    ? parseOrcadSnapshotPresence(
        await execOrcadRemoteOr(
          options,
          probeOrcadStateSnapshotCommand(
            options.host,
            orcadSnapshotPath(options, snapshot.dirName),
            orcadRemoteBaseDir(options.host, options.remoteHome)
          )
        )
      )
    : 'absent'
  const safety = assessOrcadRollback({
    record: options.record,
    snapshotPresent: presence === 'unverifiable' ? null : presence === 'present',
    census: options.census,
    targetDaemonProtocol: options.targetDaemonProtocol,
    stateWritesSinceActivation: await stateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }
  if (!snapshot || !options.record.active) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_no_active',
      reason: 'No orcad version is active on this host, so there is nothing to roll back from.'
    }
  }
  let incumbent: OrcadSlotIdentity
  try {
    incumbent = await resolveOrcadSlotIdentity(options, options.record.active)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason: `The active orcad identity could not be verified: ${errorMessage(error)} Nothing was changed.`
    }
  }

  const barrierTarget = await readOrcadRollbackBarrierTarget(options, incumbent.version)
  if (barrierTarget.state === 'refused') {
    return { outcome: 'refused', code: barrierTarget.code, reason: barrierTarget.reason }
  }
  const startedAt = now()
  let transaction: OrcadRollbackTransaction = createOrcadRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: incumbent.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, startedAt),
    rescueDirName: orcadRollbackRescueDirName(incumbent.version, startedAt.getTime()),
    now: startedAt
  })
  const fenced = await runFencedStop({
    recountCensus: options.recountCensus,
    releaseIncumbentAdmission: options.releaseIncumbentAdmission,
    now: () => now().getTime(),
    refuse: rollbackRecountRefusal,
    prepare: () => writeOrcadActivationTransaction(options, transaction),
    stale: () => ROLLBACK_STALE_COUNT,
    stop: async () => {
      lock.retainOnError()
      // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
      options = withoutAbortSignal(options)
      // The census above was taken while orcad admitted work; this stop is the proof that counts.
      return stopIncumbentBehindTerminalBarrier(
        options,
        transaction.transactionId,
        barrierTarget.context
      )
    },
    // A withdrawn stop was never sent, so the server keeps serving and takes terminals again.
    stopMayHaveBeenSent: (barrier) => barrier.state !== 'withdrawn'
  })
  if ('refused' in fenced) {
    return fenced.refused
  }
  const blocked = rollbackBarrierRefusal(fenced.stopped)
  if (blocked) {
    if (blocked.retainFence) {
      lock.retain()
    }
    const recovered = blocked.restartIncumbent
      ? ` ${await putIncumbentBack(options, lock, transaction, incumbent)}`
      : ''
    return { outcome: blocked.outcome, code: blocked.code, reason: blocked.reason + recovered }
  }
  transaction = withOrcadRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeOrcadActivationTransaction(options, transaction)

  const rescue = parseOrcadSnapshotCapture(
    await execOrcadStateMutationOr(
      options,
      captureOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        orcadSnapshotPath(options, transaction.rescue.dirName),
        orcadRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (rescue === 'failed') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'orcad_rollback_rescue_snapshot_failed',
      reason:
        'The current state could not be preserved in a rescue snapshot, so the data root was ' +
        `not replaced. ${recovered}`
    }
  }
  transaction = withOrcadRollbackRescue(transaction, rescue, now())
  await writeOrcadActivationTransaction(options, transaction)

  // Why between stop and start: the older build must never load the newer build's state.
  const restored = parseOrcadSnapshotRestore(
    await execOrcadStateMutationOr(
      options,
      restoreOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        orcadSnapshotPath(options, snapshot.dirName),
        orcadRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (restored !== 'restored') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed',
      reason: `The pre-activation snapshot could not be restored (${restored}). ${recovered}`
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeOrcadActivationTransaction(options, transaction)

  const targetDir = orcadSlotDir(options, safety.target)
  const { verdict, launchError } = await launchAndJudgeOrcadSlot(options, {
    remoteInstallDir: targetDir,
    fullVersion: safety.target,
    buildHash: options.targetBuildHash
  })
  if (verdict.decision === 'reject') {
    const reason =
      launchError === undefined
        ? verdict.reason
        : `It failed while starting: ${errorMessage(launchError)}`
    const recovered = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: targetDir,
      launchedVersion: safety.target,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: rescueVerdict(transaction),
      launchedFromState: rollbackStartingState(transaction)
    })
    return {
      outcome: 'failed',
      code: launchError === undefined ? verdict.code : 'orcad_rollback_target_launch_failed',
      reason: await withOrcadLogTail(
        options,
        targetDir,
        `The rollback target ${safety.target} did not come up healthy: ${reason} ${recovered} ` +
          `Its stderr is at ${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
      )
    }
  }

  // The record is written last: until the target is proven serving, `active` still names the
  // version an operator would need to bring back.
  transaction = withOrcadRollbackPhase(transaction, 'target-ready', now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}

type RestoreState = Parameters<typeof putTransactionIncumbentBack>[2]['restoreState']

function rescueVerdict(transaction: OrcadRollbackTransaction): RestoreState {
  return transaction.rescue.state === 'pending' ? null : transaction.rescue
}

/** Puts the rescued state back when it was replaced, then restarts the incumbent. */
async function putIncumbentBack(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl,
  transaction: OrcadRollbackTransaction,
  incumbent: OrcadSlotIdentity
): Promise<string> {
  const failure = await putTransactionIncumbentBack(options, lock, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: null,
    incumbent,
    restoreState: rescueVerdict(transaction)
  })
  return failure ?? `orcad ${incumbent.version} was restored and is serving again.`
}
